// Copy the publishable files into the public repository checkout.
//   node tools/release.mjs <path-to-public-repo>
// Refuses to run when a publishable file contains personal information (see release-files.mjs).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISH, RENAME, PUBLIC_OWNED, PERSONAL } from './release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] && resolve(process.argv[2]);
if (!target || !existsSync(join(target, '.git'))) { console.error('usage: node tools/release.mjs <public repo checkout (with .git)>'); process.exit(2); }
if (target === root || target.startsWith(root + sep)) { console.error('target must be outside the development tree'); process.exit(2); }

const SKIP = /(^|\/)(node_modules|\.git)(\/|$)|\.(log|tmp|bak)$/;
const list = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((e) => list(join(p, e))) : [p];
const files = [...PUBLISH, ...Object.keys(RENAME)].flatMap((p) => list(join(root, p))).map((f) => relative(root, f).split(sep).join('/')).filter((f) => !SKIP.test(f));
const problems = [];
for (const f of files) {
  if (!/\.(m?js|cjs|ts|json|md|html|css|ya?ml|txt|svg)$|^\.gitignore$/.test(f)) continue;
  readFileSync(join(root, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
    for (const p of PERSONAL) if (p.re.test(line)) problems.push(`${f}:${i + 1} ${p.name}`);
  });
}
if (problems.length) { console.error('personal information found, nothing copied:\n  ' + problems.join('\n  ')); process.exit(1); }

// Replace previously published content (never the repo-owned files), then copy afresh.
for (const p of [...PUBLISH, ...Object.values(RENAME)]) {
  const dest = resolve(target, p);
  if (!dest.startsWith(target + sep) || PUBLIC_OWNED.some((o) => dest === resolve(target, o))) throw new Error('refusing to touch ' + dest);
  rmSync(dest, { recursive: true, force: true });
}
for (const f of files) {
  const out = RENAME[f] || f;
  cpSync(join(root, f), join(target, out), { recursive: false });
}
console.log(`copied ${files.length} files to ${target}`);
