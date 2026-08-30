// KERNEL FILE. The heartbeat. Every few hours: load the freshest canonical world, advance it to
// the present, publish it for the browsers. GitHub Pages is the live truth; git keeps fossils.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rollMonth, type State } from './budget';
import { advance, seedFor, tickAt, type Eon } from './canon';
import { restore, verify } from './integrity';
import { World, type Checkpoint } from '../world/world';

const PAGES = process.env.PAGES_URL;
export const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
export const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

async function fromPages<T>(name: string): Promise<T | null> {
  if (!PAGES) return null;
  try { const r = await fetch(`${PAGES}${name}?t=${Date.now()}`); return r.ok ? await r.json() as T : null; } catch { return null; }
}

// Whichever copy of the world is further along wins: the last deploy or the last commit.
export async function loadLatest(): Promise<{ state: State; checkpoint: Checkpoint | null }> {
  const local: State = read('state/state.json');
  const remote = await fromPages<State>('state.json');
  const remoteCp = remote && remote.canonTick > local.canonTick ? await fromPages<Checkpoint>('checkpoint.json') : null;
  if (remote && remoteCp && remoteCp.tick === remote.canonTick) return { state: rollMonth({ ...local, genesis: remote.genesis, eons: remote.eons, canonTick: remote.canonTick, heartbeatAt: remote.heartbeatAt }), checkpoint: remoteCp };
  return { state: rollMonth(local), checkpoint: local.genesis ? read('canon/checkpoint.json') : null };
}

export function beat(state: State, checkpoint: Checkpoint | null): { world: World; ended: Eon[]; born: boolean } {
  let world: World, born = false;
  if (!state.genesis || !checkpoint) {
    state.genesis ??= new Date().toISOString();
    state.eons = [{ eon: 1, seed: seedFor(1), startTick: 0, endTick: null }];
    world = new World(state.eons[0].seed); born = true;
  } else world = World.load(checkpoint);
  const result = advance(world, tickAt(state.genesis), state.eons);
  state.canonTick = result.world.tick;
  state.heartbeatAt = new Date().toISOString();
  return { ...result, born };
}

export function saveCheckpoint(world: World) {
  mkdirSync('canon', { recursive: true }); mkdirSync('site/public', { recursive: true });
  const cp = JSON.stringify(world.save());
  writeFileSync('canon/checkpoint.json', cp); writeFileSync('site/public/checkpoint.json', cp);
}

export function publish(state: State, world: World) {
  saveCheckpoint(world);
  save('site/public/state.json', state);
  save('state/state.json', state);
  save('state/state.json', state);
  const journal = readdirSync('journal').filter(f => f.endsWith('.md')).sort().map(f => ({ name: f, body: readFileSync(`journal/${f}`, 'utf8') }));
  save('site/public/journal.json', journal.slice(-30).reverse());
  const models = Object.entries(state.models).map(([r, m]) => `| ${r} | \`${m}\` |`).join('\n');
  const key = state.keyUsage ? `$${state.keyUsage.usage.toFixed(2)}${state.keyUsage.limit ? ` of $${state.keyUsage.limit} key limit` : ''}` : 'n/a';
  const eon = state.eons[state.eons.length - 1];
  const block = `<!-- status:start -->
**Eon ${eon.eon}** since tick ${eon.startTick} · **canonical tick** ${state.canonTick} · **genesis** ${state.genesis} · **heartbeat** ${state.heartbeatAt}

**Iteration** ${state.iteration} · **last cycle** ${state.lastRun ?? 'never'} · **world score** ${state.baseline?.score ?? '—'} · **failure streak** ${state.failStreak}

**Sun (budget)** $${state.monthSpend.toFixed(2)} spent of $${state.monthlyBudget} this month (${state.month}) · lifetime key usage ${key}

| Role | Mind currently in use |
|---|---|
${models}
<!-- status:end -->`;
  writeFileSync('README.md', readFileSync('README.md', 'utf8').replace(/<!-- status:start -->[\s\S]*<!-- status:end -->/, block));
}

if (process.argv[1]?.endsWith('heartbeat.ts')) {
  (async () => {
    if (!verify()) { restore(); if (!verify()) throw new Error('kernel cannot be restored'); }
    const { state, checkpoint } = await loadLatest();
    const { world, ended, born } = beat(state, checkpoint);
    publish(state, world);
    console.log(`heartbeat: tick ${world.tick}, eon ${state.eons.length}, alive ${world.creatures.length}${born ? ', genesis' : ''}${ended.length ? `, ${ended.length} eon(s) ended` : ''}`);
  })().catch(e => { console.error(e); process.exit(1); });
}
