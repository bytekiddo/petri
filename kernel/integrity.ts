// KERNEL FILE. Verifies that the kernel has not been modified by the overseers.
// `npm run seal` is run ONCE by the human before release; after that the manifest is law.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

export const KERNEL_PATHS = ['kernel', '.github/workflows', 'package.json', 'tsconfig.json'];
const MANIFEST = 'kernel/MANIFEST';

function files(): string[] {
  const out: string[] = [];
  for (const p of KERNEL_PATHS) {
    try { for (const f of readdirSync(p)) out.push(`${p}/${f}`); } catch { out.push(p); }
  }
  return out.filter(f => f !== MANIFEST).sort();
}

export function digest(): string {
  return files().map(f => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${f}`).join('\n') + '\n';
}

export function verify(): boolean {
  try { return readFileSync(MANIFEST, 'utf8') === digest(); } catch { return false; }
}

// Restore the kernel from the last sealed commit.
export function restore(): void {
  execSync(`git checkout last-known-good -- ${KERNEL_PATHS.join(' ')}`, { stdio: 'inherit' });
}

if (process.argv[1]?.endsWith('integrity.ts')) {
  if (process.argv.includes('--write')) { writeFileSync(MANIFEST, digest()); console.log('kernel sealed'); }
  else { const ok = verify(); console.log(ok ? 'kernel intact' : 'KERNEL MODIFIED'); process.exit(ok ? 0 : 1); }
}
