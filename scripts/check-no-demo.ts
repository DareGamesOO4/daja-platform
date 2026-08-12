import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.includes('.integration.test.') && !file.includes('.unit.test.'))
  .filter((file) => !file.startsWith('docs/'))
  .filter((file) => !file.startsWith('migrations/'))
  .filter((file) => file !== 'scripts/check-no-demo.ts')
  .filter((file) => file !== 'package-lock.json')
  .filter((file) => !file.startsWith('node_modules/'));

const patterns = [
  /\bDEMO_MODE\b/,
  /\bin-memory\b/i,
  /\bfake\b/i,
  /\bstubbed success\b/i,
  /TODO:\s*implement/i,
  /not implemented/i
];

const violations: string[] = [];
for (const file of files) {
  const text = await readFile(join(process.cwd(), file), 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      violations.push(`${file}: ${pattern}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('no production demo/mock patterns found');
