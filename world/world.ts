// The engine: grid, food, population bookkeeping, the tick loop, and checkpoints.
// It knows nothing about behaviour; that lives in rules.ts.
import { migrate, mulberry32, randomGenome, type Rng } from './genome';
import { RULES, stepCreature, type Creature, type Env } from './rules';

// The canonical world is saved and restored through this shape. Older checkpoints must
// stay loadable: new fields need defaults here, new genes need defaults in GENE_DEFAULTS.
export type Checkpoint = {
  tick: number; rng: number; w: number; h: number;
  food: number[]; fertility: number[];
  creatures: { x: number; y: number; energy: number; age: number; genome: Record<string, number> }[];
};

const FERTILITY_DRIFT_INTERVAL = 20;
const TAU = Math.PI * 2;

export class World implements Env {
  w = RULES.width; h = RULES.height;
  food: Float32Array;
  fertility: Float32Array;
  creatures: Creature[] = [];
  private grid: (Creature | null)[];
  private born: Creature[] = [];
  private dead = new Set<Creature>();
  rng: Rng;
  tick = 0;

  constructor(seed: number) {
    this.rng = mulberry32(seed);
    const n = this.w * this.h;
    this.food = new Float32Array(n).fill(RULES.foodMax * 0.5);
    this.grid = new Array(n).fill(null);
    this.fertility = new Float32Array(n).fill(0.05);
    for (let p = 0; p < RULES.foodPatches; p++) {
      const cx = this.rng() * this.w, cy = this.rng() * this.h, r = 8 + this.rng() * 16;
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        const dx = Math.min(Math.abs(x - cx), this.w - Math.abs(x - cx));
        const dy = Math.min(Math.abs(y - cy), this.h - Math.abs(y - cy));
        const f = Math.exp(-(dx * dx + dy * dy) / (2 * r * r));
        this.fertility[y * this.w + x] = Math.max(this.fertility[y * this.w + x], f);
      }
    }
    for (let i = 0; i < RULES.initialPop; i++) {
      const x = Math.floor(this.rng() * this.w), y = Math.floor(this.rng() * this.h);
      if (!this.grid[y * this.w + x]) this.spawn({ x, y, energy: 1, age: 0, genome: randomGenome(this.rng) });
    }
    this.flush();
  }

  static load(cp: Checkpoint): World {
    const w = new World(0);
    w.tick = cp.tick; w.rng.state = cp.rng;
    w.food.set(cp.food); w.fertility.set(cp.fertility);
    w.creatures = []; w.grid.fill(null);
    for (const c of cp.creatures) if (!w.grid[c.y * w.w + c.x]) w.spawn({ ...c, genome: migrate(c.genome) });
    w.flush();
    return w;
  }

  save(): Checkpoint {
    const r2 = (v: number) => Math.round(v * 100) / 100, r3 = (v: number) => Math.round(v * 1000) / 1000;
    return {
      tick: this.tick, rng: this.rng.state, w: this.w, h: this.h,
      food: Array.from(this.food, r3), fertility: Array.from(this.fertility, r2),
      creatures: this.creatures.map(c => ({ x: c.x, y: c.y, energy: r3(c.energy), age: c.age,
        genome: Object.fromEntries(Object.entries(c.genome).map(([k, v]) => [k, r3(v)])) })),
    };
  }

  occupant(x: number, y: number) { return this.grid[y * this.w + x]; }
  moveTo(c: Creature, x: number, y: number) {
    this.grid[c.y * this.w + c.x] = null; c.x = x; c.y = y; this.grid[y * this.w + x] = c;
  }
  kill(c: Creature) { this.dead.add(c); this.grid[c.y * this.w + c.x] = null; }
  spawn(c: Creature) { this.born.push(c); this.grid[c.y * this.w + c.x] = c; }

  private flush() {
    if (this.dead.size) this.creatures = this.creatures.filter(c => !this.dead.has(c));
    this.dead.clear();
    for (const c of this.born) if (this.creatures.length < RULES.maxPop) this.creatures.push(c); else this.grid[c.y * this.w + c.x] = null;
    this.born.length = 0;
  }

  private driftFertility() {
    this.fertility.fill(0.05);
    for (let p = 0; p < RULES.foodPatches; p++) {
      const phase = p * 2.399963229728653;
      const baseX = ((0.137 + p * 0.618033988749895) % 1) * this.w;
      const baseY = ((0.371 + p * 0.414213562373095) % 1) * this.h;

      // Broadly separated periods prevent the patches from sweeping the dish in sync,
      // while the range of orbit sizes leaves both mobile fronts and local refuges.
      const orbitX = 14 + ((p * 17) % 27);
      const orbitY = 12 + ((p * 19) % 25);
      const periodX = 3600 + ((p * 1543) % 6200);
      const periodY = 4300 + ((p * 2371) % 5700);
      const cx = (baseX + Math.sin(this.tick * TAU / periodX + phase) * orbitX + this.w) % this.w;
      const cy = (baseY + Math.cos(this.tick * TAU / periodY + phase * 1.37) * orbitY + this.h) % this.h;
      const r = 9 + ((p * 11) % 15);
      const scale = 2 * r * r;

      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        const dx = Math.min(Math.abs(x - cx), this.w - Math.abs(x - cx));
        const dy = Math.min(Math.abs(y - cy), this.h - Math.abs(y - cy));
        const f = Math.exp(-(dx * dx + dy * dy) / scale);
        const i = y * this.w + x;
        if (f > this.fertility[i]) this.fertility[i] = f;
      }
    }
  }

  step() {
    if (this.tick % FERTILITY_DRIFT_INTERVAL === 0) this.driftFertility();

    const { food, fertility } = this;
    for (let i = 0; i < food.length; i++) food[i] = Math.min(RULES.foodMax, food[i] + RULES.foodGrowth * fertility[i]);
    // Random turn order so nobody has a permanent first-mover advantage.
    const cs = this.creatures;
    for (let i = cs.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [cs[i], cs[j]] = [cs[j], cs[i]]; }
    for (const c of cs) if (!this.dead.has(c)) stepCreature(c, this);
    this.flush();
    this.tick++;
  }
}
