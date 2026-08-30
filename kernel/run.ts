// KERNEL FILE. One evolutionary cycle of the repository. The overseers propose; this file
// decides whether the world survives what they did, and records history either way.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { budgetLeft, keyUsage, type State } from './budget';
import { beat, loadLatest, publish, read, save, saveCheckpoint } from './heartbeat';
import { KERNEL_PATHS, restore, verify } from './integrity';
import type { Metrics } from './metrics';

const LIMITS = { locGrowth: 0.15, distBytes: 1_500_000, minSurvival: 0.5, scoreFloor: 0.7, orchestratorMs: 30 * 60_000 };
const sh = (cmd: string, ms = 600_000) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms });
const SIM = 'npm run sim -- --from canon/checkpoint.json --out state/candidate.json';

type Cycle = { role: string; focus: string; hypothesis: string; verdict: 'merge' | 'reject'; reasoning: string; cost: number; journal: string; models: Record<string, string> };

function loc(): number {
  let n = 0;
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = `${d}/${f}`; if (p.includes('site/public') || p.includes('site/dist')) continue; statSync(p).isDirectory() ? walk(p) : (n += readFileSync(p, 'utf8').split('\n').length); } };
  for (const d of ['world', 'site', 'agents']) if (existsSync(d)) walk(d);
  return n;
}
function dirSize(d: string): number {
  let n = 0; if (!existsSync(d)) return 0;
  for (const f of readdirSync(d)) { const p = `${d}/${f}`; n += statSync(p).isDirectory() ? dirSize(p) : statSync(p).size; }
  return n;
}

// Would the canonical world, as it is right now, survive and flourish under the proposed laws?
function hardChecks(baseline: Metrics, locBefore: number): { ok: boolean; notes: string[]; metrics?: Metrics } {
  const notes: string[] = [];
  const fail = (s: string) => { notes.push(`FAIL ${s}`); };
  try { sh('npm run build'); notes.push('build ok'); } catch (e) { fail(`build: ${String((e as Error).message).slice(0, 400)}`); return { ok: false, notes }; }
  try { sh('npx tsc --noEmit'); notes.push('types ok'); } catch { fail('typecheck'); return { ok: false, notes }; }
  const size = dirSize('site/dist'); if (size > LIMITS.distBytes) fail(`site bundle ${size} bytes > ${LIMITS.distBytes}`);
  const growth = loc() / locBefore - 1; if (growth > LIMITS.locGrowth) fail(`LOC grew ${(growth * 100).toFixed(0)}% > ${LIMITS.locGrowth * 100}%`);
  let metrics: Metrics | undefined;
  try { sh(SIM); metrics = read('state/candidate.json'); notes.push(`branches ok score ${metrics!.score}`); }
  catch (e) { fail(`branches crashed: ${String((e as Error).message).slice(0, 400)}`); return { ok: false, notes }; }
  if (metrics!.survival < LIMITS.minSurvival) fail(`survival ${metrics!.survival} < ${LIMITS.minSurvival}`);
  if (metrics!.score < baseline.score * LIMITS.scoreFloor) fail(`score ${metrics!.score} < ${LIMITS.scoreFloor}× baseline ${baseline.score}`);
  return { ok: !notes.some(n => n.startsWith('FAIL')), notes, metrics };
}

async function main() {
  const events: string[] = [];
  if (!verify()) { restore(); events.push('Kernel had been altered; restored from last-known-good.'); if (!verify()) throw new Error('kernel cannot be restored'); }
  try { sh('git rev-parse last-known-good'); } catch { sh('git tag last-known-good'); }

  // The world catches up to the present before anyone judges it.
  const { state, checkpoint } = await loadLatest();
  state.monthlyBudget = Number(process.env.MONTHLY_BUDGET_USD ?? state.monthlyBudget ?? 10);
  const { world, ended, born } = beat(state, checkpoint);
  if (born) events.push('First light: the canonical world begins.');
  for (const e of ended) events.push(`Eon ${e.eon} ended at tick ${e.endTick}: every creature died. Eon ${e.eon + 1} began under the same laws.`);
  saveCheckpoint(world);
  const locBefore = loc();

  sh(SIM); state.baseline = read('state/candidate.json'); save('state/state.json', state);
  const baseline = state.baseline as Metrics;

  let cycle: Cycle | null = null, accepted = false, checks: ReturnType<typeof hardChecks> = { ok: false, notes: [] };
  if (budgetLeft(state) <= 0) {
    events.push(`Hibernating: the sun is spent for ${state.month}.`);
  } else {
    try { sh('npx tsx agents/orchestrator.ts', LIMITS.orchestratorMs); cycle = read('state/cycle.json'); }
    catch (e) { events.push(`The overseers crashed: ${String((e as Error).message).slice(0, 600)}`); }
    if (cycle) {
      state.monthSpend += cycle.cost || 0;
      if (cycle.models) state.models = { ...state.models, ...cycle.models };
      sh(`git checkout -- ${KERNEL_PATHS.join(' ')} && git clean -fdq kernel`); // overseers cannot touch the kernel
      checks = hardChecks(baseline, locBefore);
      accepted = cycle.verdict === 'merge' && checks.ok;
    }
  }

  if (accepted && checks.metrics) { state.baseline = checks.metrics; state.failStreak = 0; }
  else if (cycle) {
    sh('git checkout -- . && git clean -fdq -e journal -e state');
    if (++state.failStreak >= 3) { sh('git checkout last-known-good -- .'); state.failStreak = 0; events.push('Three failures in a row; laws and site restored from last-known-good.'); }
  }

  const n = String(state.iteration + 1).padStart(4, '0');
  const body = `# ${n} · ${cycle ? cycle.hypothesis : events[events.length - 1] ?? 'quiet cycle'}

> ${new Date().toISOString()} · eon ${state.eons.length} · tick ${state.canonTick} · ${cycle ? `${cycle.role} · ${cycle.focus} · ${accepted ? 'accepted' : 'rejected'}` : 'kernel'}

${cycle?.journal ?? ''}

${events.length ? `Kernel notes: ${events.join(' ')}\n` : ''}${cycle ? `Judge: ${cycle.verdict} — ${cycle.reasoning}\n\nChecks:\n\`\`\`\n${checks.notes.join('\n')}\n\`\`\`` : ''}`;

  state.iteration++; state.lastRun = new Date().toISOString(); state.keyUsage = await keyUsage();
  mkdirSync('journal', { recursive: true });
  writeFileSync(`journal/${n}.md`, body);
  publish(state, world);
  sh(`git add -A && git commit -qm "cycle ${n}: ${accepted ? 'accepted' : cycle ? 'rejected' : 'kernel'} — ${(cycle?.hypothesis ?? events.join(' ')).replace(/"/g, "'").slice(0, 80)}"`);
  if (accepted) sh('git tag -f last-known-good');
  console.log(`cycle ${n}: ${accepted ? 'ACCEPTED' : 'rejected'} · tick ${state.canonTick} · spend this month $${state.monthSpend.toFixed(3)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
