// KERNEL FILE. The clock of the canonical world. Shared by the kernel and every browser,
// so everyone computes the same world from the same checkpoint. No Node imports here.
import type { Genome } from '../world/genome';
import { World } from '../world/world';

export const TICK_MS = 1000;                    // one tick per real second, forever
export const tickAt = (genesis: string, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(genesis)) / TICK_MS));
export const seedFor = (eon: number) => (Math.imul(eon, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;

export type Eon = { eon: number; seed: number; startTick: number; endTick: number | null };

// Advance the world to the target tick. When all life is gone, a new eon begins at that
// tick with a fresh seed; the laws stay. Returns the eons that ended on the way.
export function advance(world: World, target: number, eons: Eon[], onTick?: (w: World) => void): { world: World; ended: Eon[] } {
  const ended: Eon[] = [];
  while (world.tick < target) {
    world.step();
    onTick?.(world);
    if (!world.creatures.length) {
      const last = eons[eons.length - 1];
      last.endTick = world.tick; ended.push(last);
      const next: Eon = { eon: last.eon + 1, seed: seedFor(last.eon + 1), startTick: world.tick, endTick: null };
      eons.push(next);
      const reborn = new World(next.seed);
      reborn.tick = world.tick;
      world = reborn;
    }
  }
  return { world, ended };
}


// Coarse species key over every gene except the neutral hue. Frozen so diversity cannot be redefined.
export function speciesKey(g: Genome, bins = 4): string {
  return Object.entries(g).filter(([k]) => k !== 'hue').map(([, v]) => Math.min(bins - 1, Math.floor(v * bins))).join('');
}

// 1 byte per cell: 0 empty, 1..255 hue of occupant. Used by the complexity metric and the renderer.
export function snapshot(w: World): Uint8Array {
  const s = new Uint8Array(w.w * w.h);
  for (const c of w.creatures) s[c.y * w.w + c.x] = 1 + Math.floor(c.genome.hue * 254);
  return s;
}
