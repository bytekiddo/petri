import { RULES } from '../world/rules';

const canvas = document.getElementById('dish') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const img = ctx.createImageData(RULES.width, RULES.height);
const $ = (id: string) => document.getElementById(id)!;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ base: new URL('.', location.href).href });

function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

function draw(hue: Uint8Array, food: Uint8Array, hunt: Uint8Array) {
  const d = img.data;
  for (let i = 0; i < hue.length; i++) {
    const f = food[i] / 255;
    d[i * 4] = 230 - f * 90; d[i * 4 + 1] = 236 - f * 40; d[i * 4 + 2] = 239 - f * 110; d[i * 4 + 3] = 255;
    if (hue[i]) { const [r, g, b] = hsl((hue[i] - 1) / 254, 0.75, hunt[i] ? 0.3 : 0.5); d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; }
  }
  ctx.putImageData(img, 0, 0);
}

const age = (ticks: number) => { const d = Math.floor(ticks / 86400), h = Math.floor(ticks / 3600) % 24, m = Math.floor(ticks / 60) % 60; return `${d}d ${h}h ${m}m`; };

worker.onmessage = ({ data }) => {
  if (data.type === 'frame') {
    draw(data.hue, data.food, data.hunt);
    $('stats').innerHTML = [['eon', data.eon], ['tick', data.tick], ['age', age(data.tick)], ['alive', data.alive], ['hunters', data.hunters], ['species', data.species], ['oldest', data.oldest]]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('live').textContent = 'live · one tick per second';
  } else if (data.type === 'catchup') {
    $('live').textContent = data.to > data.from ? `catching up to now · ${Math.floor(100 * (1 - (data.to - data.from) / Math.max(1, data.to)))}%` : 'live · one tick per second';
  } else if (data.type === 'reload') location.reload();
  else if (data.type === 'error') $('live').textContent = `The world could not be loaded: ${data.message}`;
};

// Status block and journal are published by the kernel.
async function loadPublished() {
  try {
    const s = await (await fetch('./state.json')).json();
    const models = Object.entries(s.models ?? {}).map(([r, m]) => `${r}: ${m}`).join('<br>');
    $('status').innerHTML =
      `<dl class="stats"><dt>genesis</dt><dd>${s.genesis?.slice(0, 10) ?? '—'}</dd><dt>iteration</dt><dd>${s.iteration}</dd><dt>world score</dt><dd>${s.baseline?.score ?? '—'}</dd>` +
      `<dt>minds</dt><dd>${models || '—'}</dd><dt class="sun">sun</dt><dd class="sun">$${(s.monthSpend ?? 0).toFixed(2)} of $${s.monthlyBudget ?? '?'} this month</dd></dl>`;
    const entries: { name: string; body: string }[] = await (await fetch('./journal.json')).json();
    $('journal').innerHTML = entries.map(e => `<article>${md(e.body)}</article>`).join('');
  } catch { $('journal').innerHTML = '<p class="meta">The journal is published by the kernel; it is not available in this build.</p>'; }
}

// Tiny markdown: headings, quotes, code fences, paragraphs. Enough for a lab notebook.
function md(src: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  return src.split(/```/).map((chunk, i) => i % 2 ? `<pre>${esc(chunk)}</pre>` :
    chunk.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p =>
      p.startsWith('# ') ? `<h3>${esc(p.slice(2))}</h3>` : p.startsWith('> ') ? `<p class="meta">${esc(p.slice(2))}</p>` : `<p>${esc(p)}</p>`).join('')).join('');
}

loadPublished();