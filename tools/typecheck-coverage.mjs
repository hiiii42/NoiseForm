// List actual compiler inputs, including transitive imports, and deferred JS modules.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const unix = (path) => path.replaceAll('\\', '/');
const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : path.endsWith('.js') ? [unix(path)] : [];
});
const inputs = execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
  '-p', join(root, 'tsconfig.check.json'), '--listFilesOnly'], { encoding: 'utf8' });
const checked = inputs.trim().split(/\r?\n/).map((path) => unix(relative(root, path)))
  .filter((path) => path.startsWith('public/js/') && path.endsWith('.js')).sort();
const deferred = walk('public/js').filter((path) => !checked.includes(path)).sort();
console.log(JSON.stringify({ checked, deferred }, null, 2));
