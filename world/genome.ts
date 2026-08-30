// Deterministic RNG with exposed state so a world can be checkpointed mid-run.
export type Rng = { (): number; state: number };
export function mulberry32(state: number): Rng {
  const r = (() => {
    r.state = (r.state + 0x6d2b79f5) >>> 0;
    let t = r.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  r.state = state >>> 0;
  return r;
}

// Heritable traits, all in [0, 1]. hue is selectively neutral: it drifts, so colour shows lineage.
export type Genome = {
  speed: number;      // chance to move each tick; moving costs energy
  sense: number;      // how far it sees; seeing costs energy
  aggression: number; // above a threshold it hunts, but digests plants poorly
  reproAt: number;    // fraction of max energy at which it divides
  hue: number;
  camo: number;
};
export const GENES = ['speed', 'sense', 'aggression', 'reproAt', 'hue', 'camo'] as const;

// Migration contract: creatures born under older laws get these values for genes they lack.
// Add a gene here whenever you add one to Genome, or the canonical world cannot be loaded.
export const GENE_DEFAULTS: Genome = { speed: 0.5, sense: 0.5, aggression: 0, reproAt: 0.6, hue: 0.5, camo: 0 };
export const migrate = (g: Record<string, number>): Genome => ({ ...GENE_DEFAULTS, ...g });

export function randomGenome(r: Rng): Genome {
  return { speed: r(), sense: r(), aggression: r() * 0.4, reproAt: 0.4 + r() * 0.5, hue: r(), camo: 0 };
}

export function mutate(g: Genome, r: Rng, rate: number): Genome {
  const out = { ...g };
  for (const k of GENES) {
    if (r() < rate) {
      const v = out[k] + (r() - 0.5) * 0.3;
      out[k] = k === 'hue' ? ((v % 1) + 1) % 1 : Math.min(1, Math.max(0, v));
    }
  }
  return out;
}
