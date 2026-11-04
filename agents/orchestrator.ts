// The overseers. This file is theirs: they may rewrite how they work together,
// as long as they still leave a state/cycle.json for the kernel at the end.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY!;
const ROLES = ['steward', 'physicist', 'ui_engineer', 'judge', 'chronicler'] as const;
type Role = typeof ROLES[number];
const FOCUS: Record<string, Role> = { world: 'physicist', site: 'ui_engineer', agents: 'physicist' };
const ALLOWED = ['world/', 'site/', 'agents/', 'README.md'];
const state = JSON.parse(readFileSync('state/state.json', 'utf8'));
const models: Record<Role, string> = state.models;
let cost = 0;

type ParseFailure = {
  role: Role;
  model: string;
  response: string;
  input: string;
  error: string;
};
let parseFailure: ParseFailure | undefined;

type DiffCompleteness = {
  ok: boolean;
  warnings: string[];
};

const role = (r: Role) => readFileSync(`agents/roles/${r}.md`, 'utf8');
const sh = (c: string) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return `ERROR ${(e as { stdout?: string; stderr?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`; } };
const tree = (d: string): string[] => readdirSync(d).flatMap(f => { const p = `${d}/${f}`; return p.includes('site/public') ? [] : statSync(p).isDirectory() ? tree(p) : [p]; });
const dump = (paths: string[]) => paths.map(p => `=== FILE ${p} ===\n${readFileSync(p, 'utf8')}\n=== END ===`).join('\n\n');
const recentJournal = () => readdirSync('journal').sort().slice(-5).map(f => readFileSync(`journal/${f}`, 'utf8')).join('\n\n---\n\n');

async function llm(model: string, system: string, user: string): Promise<string> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com', 'X-Title': 'petri' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], usage: { include: true }, temperature: 0.7 }),
  });
  const data = await r.json() as { error?: { message: string }; usage?: { cost?: number }; choices?: { message: { content: string } }[] };
  if (data.error) throw new Error(`${model}: ${data.error.message}`);
  cost += data.usage?.cost ?? 0;
  return data.choices?.[0]?.message.content ?? '';
}

// Preserve the existing extraction and strict parsing behavior. On failure,
// retain both the untouched reply and the exact input to JSON.parse; neither
// a truncated error message nor a synthetic example can reproduce that input.
const json = <T,>(s: string, source: Role): T => {
  const input = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  try {
    return JSON.parse(input);
  } catch (e) {
    if (e instanceof SyntaxError) {
      parseFailure = {
        role: source,
        model: models[source],
        response: s,
        input,
        error: String(e),
      };
    }
    throw e;
  }
};

async function marketplace(): Promise<string> {
  const { data } = await (await fetch('https://openrouter.ai/api/v1/models')).json() as { data: { id: string; context_length: number; pricing: { prompt: string; completion: string } }[] };
  const perM = (s: string) => (+s * 1e6).toFixed(2);
  return data.filter(m => m.context_length >= 32000 && +m.pricing.prompt < 2e-5)
    .map(m => `${m.id}\t$${perM(m.pricing.prompt)}/$${perM(m.pricing.completion)} per M\tctx ${m.context_length}`).join('\n');
}

type FileEdit = { path: string; content: string };

function parseEdits(text: string): { files: FileEdit[]; deletes: string[]; declarations: string } {
  const files: FileEdit[] = [];
  // Mask complete blocks before looking for declarations or deletes, so file
  // contents cannot themselves issue edits or create spurious audit warnings.
  const declarations = text.replace(/^=== FILE (\S+) ===\n([\s\S]*?)\n=== END ===/gm, (_block, path: string, content: string) => {
    files.push({ path, content });
    return `=== FILE ${path} ===`;
  });
  const deletes = [...declarations.matchAll(/^=== DELETE (\S+) ===$/gm)].map(m => m[1]);
  return { files, deletes, declarations };
}

const allowedEditablePath = (p: string) => !p.includes('..') && ALLOWED.some(a => p === a || p.startsWith(a));

function apply(text: string): { hypothesis: string; touched: string[]; before: Map<string, Buffer | null> } {
  const hypothesis = /HYPOTHESIS:\s*(.+)/.exec(text)?.[1]?.trim() ?? 'unstated';
  const touched: string[] = [];
  const before = new Map<string, Buffer | null>();
  const remember = (p: string) => {
    if (!before.has(p)) before.set(p, existsSync(p) ? readFileSync(p) : null);
  };
  const edits = parseEdits(text);
  for (const { path: p, content } of edits.files) {
    if (!allowedEditablePath(p)) continue;
    remember(p);
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); touched.push(p);
  }
  for (const p of edits.deletes) {
    if (!allowedEditablePath(p)) continue;
    if (existsSync(p)) { remember(p); unlinkSync(p); touched.push(`-${p}`); }
  }
  return { hypothesis, touched, before };
}

// Compare the bytes present immediately before and after apply(), including new
// and deleted files. Git's working-tree diff omits untracked files.
function appliedDiff(before: Map<string, Buffer | null>): string {
  const dir = mkdtempSync(join(tmpdir(), 'petri-diff-'));
  try {
    const sections: string[] = [];
    for (const [path, oldBytes] of before) {
      const newBytes = existsSync(path) ? readFileSync(path) : null;
      if (oldBytes === null && newBytes === null) continue;
      if (oldBytes !== null && newBytes !== null && oldBytes.equals(newBytes)) continue;
      const oldPath = oldBytes === null ? '/dev/null' : join(dir, 'before');
      const newPath = newBytes === null ? '/dev/null' : join(dir, 'after');
      if (oldBytes !== null) writeFileSync(oldPath, oldBytes);
      if (newBytes !== null) writeFileSync(newPath, newBytes);
      const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', oldPath, newPath], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || (result.status !== 0 && result.status !== 1)) {
        throw new Error(`Cannot diff ${path}: ${result.error ?? result.stderr}`);
      }
      sections.push(`Applied change: ${path}\n${result.stdout}`);
    }
    return sections.join('\n') || '(no byte changes)';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkDeclaredVsTouched(reply: string, touched: string[]): DiffCompleteness {
  const declared = new Set<string>();
  const warnings: string[] = [];
  const { declarations } = parseEdits(reply);
  for (const m of declarations.matchAll(/^=== FILE (\S+) ===$/gm)) {
    const p = m[1];
    if (!allowedEditablePath(p)) { warnings.push(`unsafe or out-of-scope FILE path ignored: ${p}`); continue; }
    declared.add(p);
  }
  for (const m of declarations.matchAll(/^=== DELETE (\S+) ===$/gm)) {
    const p = m[1];
    if (!allowedEditablePath(p)) { warnings.push(`unsafe or out-of-scope DELETE path ignored: ${p}`); continue; }
    declared.add(`-${p}`);
  }
  const touchedSet = new Set(touched);
  for (const d of declared) if (!touchedSet.has(d)) warnings.push(`declared but not applied: ${d}`);
  for (const t of touchedSet) if (!declared.has(t)) warnings.push(`applied but not declared: ${t}`);
  return { ok: warnings.length === 0, warnings };
}

function relativeImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
}

function missingImportsFor(source: string, importingFile: string, exists: (p: string) => boolean): string[] {
  const warnings: string[] = [];
  for (const spec of relativeImportSpecifiers(source)) {
    const base = `${dirname(importingFile)}/${spec}`;
    const found = exists(base) || exists(`${base}.ts`) || exists(`${base}.tsx`) || exists(`${base}.js`) || exists(`${base}/index.ts`) || exists(`${base}/index.js`);
    if (!found) warnings.push(`${importingFile} imports missing ${spec} (resolved ${base})`);
  }
  return warnings;
}

function auditDiff(reply: string, touched: string[]): DiffCompleteness {
  const warnings = checkDeclaredVsTouched(reply, touched).warnings;
  for (const p of touched) {
    if (p.startsWith('-')) continue;
    if (!/\.(ts|tsx|js)$/.test(p)) continue;
    if (!existsSync(p)) { warnings.push(`touched file no longer exists after apply: ${p}`); continue; }
    warnings.push(...missingImportsFor(readFileSync(p, 'utf8'), p, x => existsSync(x)));
  }
  return { ok: warnings.length === 0, warnings };
}

function diffFixtures(): { ok: boolean; report: string } {
  const validDeclaration = checkDeclaredVsTouched(
    `HYPOTHESIS: fixture\n=== FILE agents/roles/judge.md ===\nchanged\n=== END ===\n=== DELETE agents/old.ts ===`,
    ['agents/roles/judge.md', '-agents/old.ts'],
  );
  const incompleteDeclaration = checkDeclaredVsTouched(
    `HYPOTHESIS: fixture\n=== FILE agents/roles/judge.md ===\nchanged`,
    [],
  );
  const nested = parseEdits(`=== FILE agents/example.ts ===\n=== DELETE agents/old.ts ===\n=== END ===`);
  const absentImport = missingImportsFor(`import { x } from './missing';`, 'agents/orchestrator.ts', () => false);
  const presentImport = missingImportsFor(`import { x } from './present';`, 'agents/orchestrator.ts', () => true);
  const ok = validDeclaration.ok && !incompleteDeclaration.ok &&
    nested.files.length === 1 && nested.deletes.length === 0 &&
    absentImport.length > 0 && presentImport.length === 0;
  return { ok, report: `declaration valid=${validDeclaration.ok}, incomplete=${incompleteDeclaration.ok}; nested-delete ignored=${nested.deletes.length === 0}; missing-import absent-warns=${absentImport.length > 0}, present-clean=${presentImport.length === 0}` };
}

// Reuse the current Node loader to load the on-disk module without starting a
// cycle. This is a fixed check, not a command supplied by the proposer.
function orchestratorLoadCheck(): { ok: boolean; report: string } {
  const result = spawnSync(process.execPath, [...process.execArgv, 'agents/orchestrator.ts'], {
    encoding: 'utf8',
    env: { ...process.env, PETRI_ORCHESTRATOR_LOAD_CHECK: '1' },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const ok = result.status === 0 && !result.error;
  return { ok, report: `orchestrator load ${ok ? 'ok' : 'failed'}: ${result.stdout}${result.stderr}${result.error ?? ''}`.trim() };
}

async function main() {
  const baseline = JSON.stringify(state.baseline);
  const budget = `Budget: $${state.monthSpend.toFixed(2)} of $${state.monthlyBudget} used this month.`;

  // 1. The steward chooses minds and where to focus this cycle.
  const plan = json<{ models: Partial<Record<Role, string>>; focus: keyof typeof FOCUS; note: string }>(
    await llm(models.steward, role('steward'), `${budget}\nCurrent minds: ${JSON.stringify(models)}\nBaseline metrics: ${baseline}\n\nRecent journal:\n${recentJournal()}\n\nMarketplace (id, prompt/completion price, context):\n${await marketplace()}`), 'steward');
  for (const r of ROLES) if (plan.models?.[r]) models[r] = plan.models[r]!;
  const focus = plan.focus in FOCUS ? plan.focus : 'world';
  const proposer = FOCUS[focus];

  // 2. The proposer changes the world (or the site, or the overseers themselves).
  const context = `${budget}\nFocus this cycle: ${focus}. Steward's note: ${plan.note}\nBaseline metrics: ${baseline}\n\nHow the kernel measures the world (read-only):\n${dump(['kernel/metrics.ts'])}\n\nRecent journal:\n${recentJournal()}\n\nFiles you may edit:\n${dump(tree(focus === 'agents' ? 'agents' : focus))}`;
  const proposal = await llm(models[proposer], role(proposer), context);
  const { hypothesis, touched, before } = apply(proposal);
  const diff = appliedDiff(before);
  const completeness = auditDiff(proposal, touched);
  const fixtures = diffFixtures();
  const completenessReport = `ok=${completeness.ok}${completeness.warnings.length ? `; warnings: ${completeness.warnings.join('; ')}` : ''}. fixtures: ${fixtures.report}`;
  const loadCheck = orchestratorLoadCheck();

  // 3. Measure.
  const build = sh('npm run build 2>&1 | tail -5');
  const sim = sh('npm run sim -- --from canon/checkpoint.json --out state/candidate.json 2>&1 | tail -8');
  const candidate = existsSync('state/candidate.json') ? readFileSync('state/candidate.json', 'utf8') : 'sim produced nothing';

  // 4. The judge decides.
  const verdict = json<{ verdict: 'merge' | 'reject'; reasoning: string }>(
    await llm(models.judge, role('judge'), `Hypothesis: ${hypothesis}\nFiles touched: ${touched.join(', ') || 'none'}\nDiff completeness: ${completenessReport}\nModule check: ${loadCheck.report}\nBaseline: ${baseline}\nCandidate: ${candidate}\nBuild:\n${build}\nSim:\n${sim}\n\nApplied diff:\n${diff}`), 'judge');
  if (!loadCheck.ok || !fixtures.ok) {
    verdict.verdict = 'reject';
    verdict.reasoning = `Workflow check failed. ${loadCheck.report}; ${fixtures.report}. Judge: ${verdict.reasoning}`;
  }

  // 5. The chronicler writes it down for the humans watching.
  const journal = await llm(models.chronicler, role('chronicler'),
    `Iteration ${state.iteration + 1}. Focus: ${focus}. Proposer: ${proposer} (${models[proposer]}). Judge: ${models.judge}.\nSteward's note: ${plan.note}\nHypothesis: ${hypothesis}\nFiles touched: ${touched.join(', ')}\nDiff completeness: ${completenessReport}\nModule check: ${loadCheck.report}\nBaseline: ${baseline}\nCandidate: ${candidate}\nVerdict: ${verdict.verdict} — ${verdict.reasoning}\n\nApplied diff (excerpt):\n${diff.slice(0, 8000)}`);

  writeFileSync('state/cycle.json', JSON.stringify({ role: proposer, focus, hypothesis, verdict: verdict.verdict, reasoning: verdict.reasoning, diffCompleteness: completenessReport, moduleCheck: loadCheck.report, cost, journal, models }, null, 2));
}

if (process.env.PETRI_ORCHESTRATOR_LOAD_CHECK === '1') {
  const fixtures = diffFixtures();
  console.log(fixtures.report);
  if (!fixtures.ok) process.exitCode = 1;
} else {
  main().catch(e => {
    // Even a crash should cost the kernel nothing to understand.
    // Also retain the fixture in the journal, which outlives state/cycle.json.
    // Indented JSON avoids letting response text terminate a Markdown fence.
    const fixture = parseFailure
      ? `\n\nRecorded parser failure (JSON fixture; not repaired or retried):\n\n${JSON.stringify(parseFailure, null, 2).split('\n').map(line => `    ${line}`).join('\n')}`
      : '';
    writeFileSync('state/cycle.json', JSON.stringify({ role: 'overseers', focus: 'crash', hypothesis: 'overseers crashed', verdict: 'reject', reasoning: String(e).slice(0, 800), cost, journal: `The overseers could not complete the cycle.\n\n\`\`\`\n${String(e).slice(0, 800)}\n\`\`\`${fixture}`, models, parseFailure }, null, 2));
    process.exit(0);
  });
}