// KERNEL FILE. Runs the world without a screen and writes metrics. Usage:
//   npm run sim -- [--seeds 5] [--ticks 4000] [--from canon/checkpoint.json] [--out state/candidate.json]
// With --from, each seed is a counterfactual branch of the canonical world under the current laws.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { computeMetrics, type RunLog } from './metrics';
import { snapshot } from './canon';
import { World } from '../world/world';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const seeds = +arg('seeds', '5'), ticks = +arg('ticks', '4000'), out = arg('out', 'state/candidate.json'), from = arg('from', '');
const SAMPLE = 50, SNAP = Math.floor(ticks / 4);
const checkpoint = from && existsSync(from) ? JSON.parse(readFileSync(from, 'utf8')) : null;

const runs: RunLog[] = [];
const t0 = Date.now();
for (let s = 1; s <= seeds; s++) {
  const w = checkpoint ? World.load(checkpoint) : new World(s);
  if (checkpoint) w.rng.state = (w.rng.state ^ Math.imul(s, 0x9e3779b1)) >>> 0;
  const log: RunLog = { seed: s, ticks, popSeries: [], extinctAt: null, finalGenomes: [], snapshots: [] };
  for (let t = 0; t < ticks; t++) {
    w.step();
    if (t % SAMPLE === 0) log.popSeries.push(w.creatures.length);
    if (t % SNAP === SNAP - 1) log.snapshots.push(snapshot(w));
    if (!w.creatures.length) { log.extinctAt = t; break; }
  }
  log.finalGenomes = w.creatures.map(c => c.genome);
  runs.push(log);
  console.error(`branch ${s}: pop ${w.creatures.length}${log.extinctAt !== null ? ` (extinct at ${log.extinctAt})` : ''}`);
}
const metrics = computeMetrics(runs);
writeFileSync(out, JSON.stringify({ ...metrics, from: checkpoint ? `tick ${checkpoint.tick}` : 'fresh seeds', wallMs: Date.now() - t0 }, null, 2));
console.log(JSON.stringify(metrics));
