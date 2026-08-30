// KERNEL FILE. Frozen. The agents cannot change how "interesting" is measured.
// Every score lives in [0, 1]; the aggregate is a geometric mean, so a zero anywhere is fatal.
import { gzipSync } from 'node:zlib';
import type { Genome } from '../world/genome';
import { speciesKey } from './canon';

export type RunLog = {
  seed: number;
  ticks: number;
  popSeries: number[];          // population sampled at a fixed interval
  extinctAt: number | null;
  finalGenomes: Genome[];
  snapshots: Uint8Array[];      // occupancy/hue grids taken during the run
};

export type Metrics = {
  survival: number;    // fraction of seeds that did not go extinct
  persistence: number; // mean fraction of the run the population was alive
  diversity: number;   // normalised Shannon entropy of species at the end
  dynamism: number;    // population keeps changing (cycles) rather than freezing
  complexity: number;  // spatial structure: neither empty nor noise
  score: number;
  seeds: number;
  ticks: number;
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function entropy(genomes: Genome[]): number {
  if (!genomes.length) return 0;
  const counts = new Map<string, number>();
  for (const g of genomes) { const k = speciesKey(g); counts.set(k, (counts.get(k) ?? 0) + 1); }
  let h = 0;
  for (const n of counts.values()) { const p = n / genomes.length; h -= p * Math.log2(p); }
  return clamp01(h / 6); // 6 bits ≈ 64 balanced species; more than enough headroom
}

function dynamism(series: number[]): number {
  const half = series.slice(Math.floor(series.length / 2));
  if (half.length < 4) return 0;
  const mean = half.reduce((a, b) => a + b, 0) / half.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(half.reduce((a, b) => a + (b - mean) ** 2, 0) / half.length);
  return clamp01((sd / mean) / 0.25); // a 25% coefficient of variation scores full marks
}

function complexity(snaps: Uint8Array[]): number {
  if (!snaps.length) return 0;
  let acc = 0;
  for (const s of snaps) {
    const ratio = gzipSync(Buffer.from(s)).length / s.length; // ~0 empty, ~1 pure noise
    acc += 1 - Math.abs(ratio - 0.35) / 0.35;                   // reward the structured middle
  }
  return clamp01(acc / snaps.length);
}

export function computeMetrics(runs: RunLog[]): Metrics {
  const n = runs.length;
  const avg = (f: (r: RunLog) => number) => runs.reduce((a, r) => a + f(r), 0) / n;
  const m = {
    survival: avg(r => (r.extinctAt === null ? 1 : 0)),
    persistence: avg(r => (r.extinctAt === null ? 1 : r.extinctAt / r.ticks)),
    diversity: avg(r => entropy(r.finalGenomes)),
    dynamism: avg(r => dynamism(r.popSeries)),
    complexity: avg(r => complexity(r.snapshots)),
  };
  const parts = Object.values(m);
  const score = parts.reduce((a, b) => a * Math.max(b, 1e-6), 1) ** (1 / parts.length);
  return { ...m, score: +score.toFixed(4), seeds: n, ticks: runs[0]?.ticks ?? 0 };
}
