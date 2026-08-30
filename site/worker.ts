// The canonical world, replayed from the kernel's last checkpoint and kept at one tick per second.
// Every browser that opens the page runs this same computation from the same checkpoint.
import { advance, snapshot, speciesKey, tickAt, TICK_MS, type Eon } from '../kernel/canon';
import { RULES } from '../world/rules';
import { World, type Checkpoint } from '../world/world';

type State = { genesis: string; eons: Eon[]; canonTick: number; iteration: number };
const RESYNC_MS = 15 * 60_000;
let world: World, state: State, loadedTick = -1, base = '';

// Relative URLs inside a worker resolve against the script, not the page, so the page sends its base.
const fetchJson = <T,>(name: string) => fetch(new URL(`${name}?t=${Date.now()}`, base)).then(r => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json() as Promise<T>; });

function frame() {
  const cs = world.creatures;
  const hunters = cs.filter(c => c.genome.aggression > RULES.attackThreshold).length;
  const species = new Set(cs.map(c => speciesKey(c.genome))).size;
  const oldest = cs.reduce((a, c) => Math.max(a, c.age), 0);
  const hue = snapshot(world), food = Uint8Array.from(world.food, f => f * 255);
  const hunt = new Uint8Array(world.w * world.h);
  for (const c of cs) if (c.genome.aggression > RULES.attackThreshold) hunt[c.y * world.w + c.x] = 1;
  postMessage({ type: 'frame', tick: world.tick, eon: state.eons[state.eons.length - 1].eon, alive: cs.length, hunters, species, oldest, hue, food, hunt }, { transfer: [hue.buffer, food.buffer, hunt.buffer] });
}

async function sync() {
  const s = await fetchJson<State>('state.json');
  if (state && s.iteration !== state.iteration) { postMessage({ type: 'reload' }); return; }
  if (s.canonTick <= loadedTick) return;
  const cp = await fetchJson<Checkpoint>('checkpoint.json');
  state = s; loadedTick = cp.tick;
  world = World.load(cp);
  const target = tickAt(state.genesis);
  postMessage({ type: 'catchup', from: world.tick, to: target });
  // Catch up in slices so progress can be shown; the worker never blocks the page anyway.
  while (world.tick < target) {
    const slice = Math.min(target, world.tick + 200);
    world = advance(world, slice, state.eons).world;
    postMessage({ type: 'catchup', from: world.tick, to: target });
    await new Promise(r => setTimeout(r));
  }
  frame();
}

self.onmessage = ({ data }) => {
  base = data.base;
  sync().then(() => {
    setInterval(() => { world = advance(world, tickAt(state.genesis), state.eons).world; frame(); }, TICK_MS);
    setInterval(() => sync().catch(() => {}), RESYNC_MS);
  }).catch(e => postMessage({ type: 'error', message: String(e) }));
};