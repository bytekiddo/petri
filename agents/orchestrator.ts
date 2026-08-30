// The overseers. This file is theirs: they may rewrite how they work together,
// as long as they still leave a state/cycle.json for the kernel at the end.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY = process.env.OPENROUTER_API_KEY!;
const ROLES = ['steward', 'physicist', 'ui_engineer', 'judge', 'chronicler'] as const;
type Role = typeof ROLES[number];
const FOCUS: Record<string, Role> = { world: 'physicist', site: 'ui_engineer', agents: 'physicist' };
const ALLOWED = ['world/', 'site/', 'agents/', 'README.md'];
const state = JSON.parse(readFileSync('state/state.json', 'utf8'));
const models: Record<Role, string> = state.models;
let cost = 0;

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
const json = <T,>(s: string): T => JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));

async function marketplace(): Promise<string> {
  const { data } = await (await fetch('https://openrouter.ai/api/v1/models')).json() as { data: { id: string; context_length: number; pricing: { prompt: string; completion: string } }[] };
  const perM = (s: string) => (+s * 1e6).toFixed(2);
  return data.filter(m => m.context_length >= 32000 && +m.pricing.prompt < 2e-5)
    .map(m => `${m.id}\t$${perM(m.pricing.prompt)}/$${perM(m.pricing.completion)} per M\tctx ${m.context_length}`).join('\n');
}

function apply(text: string): { hypothesis: string; touched: string[] } {
  const hypothesis = /HYPOTHESIS:\s*(.+)/.exec(text)?.[1]?.trim() ?? 'unstated';
  const touched: string[] = [];
  for (const m of text.matchAll(/=== FILE (\S+) ===\n([\s\S]*?)\n=== END ===/g)) {
    const p = m[1];
    if (p.includes('..') || !ALLOWED.some(a => p === a || p.startsWith(a))) continue;
    mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, m[2]); touched.push(p);
  }
  for (const m of text.matchAll(/=== DELETE (\S+) ===/g)) if (ALLOWED.some(a => m[1].startsWith(a)) && existsSync(m[1])) { unlinkSync(m[1]); touched.push(`-${m[1]}`); }
  return { hypothesis, touched };
}

async function main() {
  const baseline = JSON.stringify(state.baseline);
  const budget = `Budget: $${state.monthSpend.toFixed(2)} of $${state.monthlyBudget} used this month.`;

  // 1. The steward chooses minds and where to focus this cycle.
  const plan = json<{ models: Partial<Record<Role, string>>; focus: keyof typeof FOCUS; note: string }>(
    await llm(models.steward, role('steward'), `${budget}\nCurrent minds: ${JSON.stringify(models)}\nBaseline metrics: ${baseline}\n\nRecent journal:\n${recentJournal()}\n\nMarketplace (id, prompt/completion price, context):\n${await marketplace()}`));
  for (const r of ROLES) if (plan.models?.[r]) models[r] = plan.models[r]!;
  const focus = plan.focus in FOCUS ? plan.focus : 'world';
  const proposer = FOCUS[focus];

  // 2. The proposer changes the world (or the site, or the overseers themselves).
  const context = `${budget}\nFocus this cycle: ${focus}. Steward's note: ${plan.note}\nBaseline metrics: ${baseline}\n\nHow the kernel measures the world (read-only):\n${dump(['kernel/metrics.ts'])}\n\nRecent journal:\n${recentJournal()}\n\nFiles you may edit:\n${dump(tree(focus === 'agents' ? 'agents' : focus))}`;
  const { hypothesis, touched } = apply(await llm(models[proposer], role(proposer), context));

  // 3. Measure.
  const build = sh('npm run build 2>&1 | tail -5');
  const sim = sh('npm run sim -- --from canon/checkpoint.json --out state/candidate.json 2>&1 | tail -8');
  const candidate = existsSync('state/candidate.json') ? readFileSync('state/candidate.json', 'utf8') : 'sim produced nothing';
  const diff = sh('git diff --stat && git diff -- . ":!site/public"').slice(0, 30000);

  // 4. The judge decides.
  const verdict = json<{ verdict: 'merge' | 'reject'; reasoning: string }>(
    await llm(models.judge, role('judge'), `Hypothesis: ${hypothesis}\nFiles touched: ${touched.join(', ') || 'none'}\nBaseline: ${baseline}\nCandidate: ${candidate}\nBuild:\n${build}\nSim:\n${sim}\n\nDiff:\n${diff}`));

  // 5. The chronicler writes it down for the humans watching.
  const journal = await llm(models.chronicler, role('chronicler'),
    `Iteration ${state.iteration + 1}. Focus: ${focus}. Proposer: ${proposer} (${models[proposer]}). Judge: ${models.judge}.\nSteward's note: ${plan.note}\nHypothesis: ${hypothesis}\nFiles touched: ${touched.join(', ')}\nBaseline: ${baseline}\nCandidate: ${candidate}\nVerdict: ${verdict.verdict} — ${verdict.reasoning}\n\nDiff (excerpt):\n${diff.slice(0, 8000)}`);

  writeFileSync('state/cycle.json', JSON.stringify({ role: proposer, focus, hypothesis, verdict: verdict.verdict, reasoning: verdict.reasoning, cost, journal, models }, null, 2));
}

main().catch(e => {
  // Even a crash should cost the kernel nothing to understand.
  writeFileSync('state/cycle.json', JSON.stringify({ role: 'overseers', focus: 'crash', hypothesis: 'overseers crashed', verdict: 'reject', reasoning: String(e).slice(0, 800), cost, journal: `The overseers could not complete the cycle.\n\n\`\`\`\n${String(e).slice(0, 800)}\n\`\`\``, models }, null, 2));
  process.exit(0);
});
