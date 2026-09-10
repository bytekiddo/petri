// The laws of nature. This is the file the Physicist is expected to change.
// world.ts is the engine (grid, loop, bookkeeping); this file decides what a creature does.
import { mutate, type Genome, type Rng } from './genome';

export const RULES = {
  width: 128,
  height: 128,
  initialPop: 300,
  maxPop: 3000,
  foodPatches: 7,      // fertile regions; food grows faster near their centres
  foodGrowth: 0.001,   // per tick, scaled by local fertility
  foodMax: 1,
  eatRate: 0.25,       // max plant energy consumed per tick
  maxEnergy: 2,
  metabolism: 0.005,   // baseline cost per tick
  moveCost: 0.01,      // per move, scaled by speed
  crowdingThreshold: 2, // immediate neighbors required before movement is subsidized
  crowdingMoveDiscount: 0.25, // fraction of move cost rebated in crowded cells
  senseCost: 0.003,    // per tick, scaled by sense
  attackThreshold: 0.5,
  attackGain: 0.6,     // fraction of the victim's energy the attacker keeps
  childEnergy: 0.5,    // energy handed to a newborn
  mutationRate: 0.1,
};

export type Creature = { x: number; y: number; energy: number; age: number; genome: Genome };

// What the engine exposes to a creature during its turn.
export interface Env {
  w: number; h: number;
  food: Float32Array;
  occupant(x: number, y: number): Creature | null;
  moveTo(c: Creature, x: number, y: number): void;
  kill(c: Creature): void;
  spawn(c: Creature): void;
  rng: Rng;
}

export function senseRadius(g: Genome): number {
  return 1 + Math.round(g.sense * 2);
}

export function stepCreature(c: Creature, env: Env): void {
  const { w, h, food, rng } = env;
  const g = c.genome;
  const hunter = g.aggression > RULES.attackThreshold;
  const radius = senseRadius(g);

  // Immediate occupancy is a cheap local measure of crowding. Dense clusters make
  // departure cheaper, so individuals can more readily disperse into open space.
  let neighbors = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const x = (c.x + dx + w) % w, y = (c.y + dy + h) % h;
    if (env.occupant(x, y)) neighbors++;
  }
  const crowded = neighbors > RULES.crowdingThreshold;

  // Look around: best food cell, and (if hunting) the nearest weaker creature.
  let bestScore = 0, tx = c.x, ty = c.y, prey: Creature | null = null, preyDist = Infinity;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (!dx && !dy) continue;
    const x = (c.x + dx + w) % w, y = (c.y + dy + h) % h;
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    const other = env.occupant(x, y);
    if (hunter && other && other.energy < c.energy && d < preyDist) { prey = other; preyDist = d; }
    const s = food[y * w + x] / d;
    if (!other && s > bestScore) { bestScore = s; tx = x; ty = y; }
  }
  if (prey) { tx = prey.x; ty = prey.y; }

  // Move one step toward the target (or wander) with probability = speed.
  let moved = false;
  if (rng() < g.speed) {
    let dx = Math.sign(((tx - c.x + w * 1.5) % w) - w / 2), dy = Math.sign(((ty - c.y + h * 1.5) % h) - h / 2);
    if (tx === c.x && ty === c.y) { dx = Math.floor(rng() * 3) - 1; dy = Math.floor(rng() * 3) - 1; }
    const nx = (c.x + dx + w) % w, ny = (c.y + dy + h) % h;
    const other = env.occupant(nx, ny);
    if (!other) { env.moveTo(c, nx, ny); moved = true; }
    else if (hunter && other.energy < c.energy) {
      c.energy = Math.min(RULES.maxEnergy, c.energy + other.energy * RULES.attackGain);
      env.kill(other);
      env.moveTo(c, nx, ny); moved = true;
    }
  }

  // Eat what's underfoot. Hunters digest plants poorly: the trade-off that makes niches.
  const i = c.y * w + c.x;
  const bite = Math.min(food[i], RULES.eatRate) * (1 - g.aggression * 0.8);
  food[i] -= bite;
  c.energy = Math.min(RULES.maxEnergy, c.energy + bite);

  // Pay for living. Crowding discounts movement enough to encourage dispersal,
  // without altering baseline metabolism or the value of stationary foraging.
  const moveMultiplier = crowded ? 1 - RULES.crowdingMoveDiscount : 1;
  c.energy -= RULES.metabolism + (moved ? RULES.moveCost * g.speed * moveMultiplier : 0) + RULES.senseCost * g.sense;
  c.age++;
  if (c.energy <= 0) { env.kill(c); return; }

  // Divide.
  if (c.energy > g.reproAt * RULES.maxEnergy) {
    const dx = Math.floor(rng() * 3) - 1, dy = Math.floor(rng() * 3) - 1;
    const nx = (c.x + dx + w) % w, ny = (c.y + dy + h) % h;
    if ((dx || dy) && !env.occupant(nx, ny)) {
      c.energy -= RULES.childEnergy;
      env.spawn({ x: nx, y: ny, energy: RULES.childEnergy, age: 0, genome: mutate(g, rng, RULES.mutationRate) });
    }
  }
}