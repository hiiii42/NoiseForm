// Repository checks using only Node built-ins. Never read APIKEY.txt or print token values.
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const unix = (path) => path.replaceAll('\\', '/');
const read = (path) => readFileSync(join(root, path), 'utf8');
const exists = (path) => existsSync(join(root, path));
const excluded = (path) => path.split('/').some((part) => part === 'node_modules' || part === '.git') || /^docs\/reviews\/evidence-[^/]+(?:\/|$)/.test(path);
const tokenPattern = /\b(?:pst-|sk-)[A-Za-z0-9_-]{20,}/g;
const redact = (s) => s.replace(tokenPattern, '[REDACTED]');
let failures = 0;
const fail = (message) => { failures++; console.error('FAIL ' + redact(message)); };
const ok = (message) => console.log('ok   ' + message);

function walk(dir = '') {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = unix(join(dir, entry.name));
    if (excluded(path) || entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const files = walk().sort();
for (const path of files.filter((path) => path.startsWith('test/') && !/(?:^|\/)APIKEY\.txt$/i.test(path))) {
  if (/D:[/\\]+Temp\b/i.test(read(path))) fail(`machine-specific test output path in ${path}; use harness artifact(name)`);
}
ok('test output paths: no machine-specific Temp paths');
// Only frontend .js files are ESM. The static package.json contains no secrets,
// changes no browser behavior, and does not affect server.js or .mjs test/tools.
if (JSON.parse(read('public/js/package.json')).type !== 'module') fail('frontend package must declare type:module');
const scripts = files.filter((path) => /\.(?:js|mjs|cjs)$/.test(path));
for (const path of scripts) {
  const result = spawnSync(process.execPath, ['--check', join(root, path)], { encoding: 'utf8' });
  if (result.status !== 0) fail(`syntax ${path}\n${result.stderr || result.error || 'node --check failed'}`);
}
ok(`syntax: checked ${scripts.length} .js/.mjs/.cjs files (excluding node_modules and review evidence)`);

const modules = scripts.filter((path) => path.startsWith('public/js/'));
const graph = new Map(modules.map((path) => [path, new Set()]));
// Ask Node's own parser for static imports/re-exports without linking or executing
// modules. The flag is confined to this subprocess; no package type/dependency change.
const parsed = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', `
  import { SourceTextModule } from 'node:vm';
  import { readFileSync } from 'node:fs';
  const modules = JSON.parse(readFileSync(0, 'utf8'));
  console.log(JSON.stringify(modules.map(([path, source]) => {
    try { return { path, imports: new SourceTextModule(source, { identifier: path }).dependencySpecifiers }; }
    catch (error) { return { path, imports: [], error: error.message }; }
  })));
`], { input: JSON.stringify(modules.map((path) => [path, read(path)])), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
let importRecords = [];
if (parsed.status !== 0) fail('static import parser failed: ' + (parsed.stderr || parsed.error));
else {
  try { importRecords = JSON.parse(parsed.stdout); }
  catch (error) { fail('static import parser returned invalid output: ' + error.message); }
}
// Exact existing edges outside step 6B's write scope. A new UI dependency is an
// error even in these files; generate/records/tools and the queue facade have none.
const uiDependencyExceptions = new Map([
  ['public/js/app/editor.js -> public/js/ui/modal.js', 'Editor reuse/undo toast; editor commands are outside this change.'],
  ['public/js/app/account.js -> public/js/ui/modal.js', 'Account refresh warnings; account display is outside this change.'],
  ['public/js/app/keys.js -> public/js/ui/archive.js', 'Keyboard selection/navigation adapter; outside this change.'],
  ['public/js/app/keys.js -> public/js/ui/modal.js', 'Keyboard modal focus guard; outside this change.'],
  ['public/js/app/keys.js -> public/js/ui/workbench.js', 'Keyboard post-processing mode guard; outside this change.'],
  ['public/js/queue/view.js -> public/js/ui/modal.js', 'Existing queue UI renderer; moving queue/view is outside the assigned facade-only scope.'],
  ['public/js/queue/view.js -> public/js/ui/archive.js', 'Queue UI archive search navigation; same renderer scope boundary.'],
  ['public/js/queue/view.js -> public/js/ui/xy-copy.js', 'Queue UI X/Y copy labels; same renderer scope boundary.'],
]);
let uiExceptions = 0;
for (const { path, imports, error } of importRecords) {
  if (error) fail(`static imports in ${path}: ${error}`);
  for (const specifier of imports) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) { fail(`nonlocal static import in ${path}: ${specifier}`); continue; }
    const target = unix(relative(root, resolve(specifier.startsWith('/') ? join(root, 'public') : dirname(join(root, path)), specifier.replace(/^\//, '').split(/[?#]/)[0])));
    if (/^public\/js\/(?:app\/[^/]+\.js|queue\.js|queue\/.*\.js)$/.test(path) && target.startsWith('public/js/ui/')) {
      const reason = uiDependencyExceptions.get(`${path} -> ${target}`);
      if (!reason) fail(`application imports UI: ${path} -> ${specifier}`);
      else uiExceptions++;
    }
    if (!graph.has(target)) { fail(`unresolved static import: ${path} -> ${specifier}`); continue; }
    graph.get(path).add(target);
  }
}
ok(`application/UI boundary: ${uiExceptions} explicit legacy edges (generate/records/tools/queue facade: zero allowed)`);

// Exact SCC membership only: adding another module to this cycle is still a failure.
const knownCycles = new Set();
let seq = 0;
let cycles = 0;
let warnings = 0;
const stack = [];
const active = new Set();
const indices = new Map();
const low = new Map();
function visit(node) {
  indices.set(node, seq);
  low.set(node, seq++);
  stack.push(node);
  active.add(node);
  for (const target of graph.get(node)) {
    if (!indices.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
    else if (active.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
  }
  if (low.get(node) !== indices.get(node)) return;
  const group = [];
  let member;
  do { member = stack.pop(); active.delete(member); group.push(member); } while (member !== node);
  if (group.length === 1 && !graph.get(node).has(node)) return;
  cycles++;
  const key = group.sort().join('|');
  if (knownCycles.has(key)) { warnings++; console.warn('WARN known cycle (round 2): ' + group.join(' <-> ')); }
  else fail('new static import cycle: ' + group.join(' <-> '));
}
for (const node of graph.keys()) if (!indices.has(node)) visit(node);
ok(`static imports: ${modules.length} modules, ${cycles} cycle groups, ${warnings} known exceptions`);

const version = JSON.parse(read('package.json')).version;
const versions = {
  'package.json': version,
  'index .brand-v': read('public/index.html').match(/<[^>]*class=["'][^"']*\bbrand-v\b[^"']*["'][^>]*>\s*v(\d+\.\d+\.\d+)\s*</)?.[1],
  'CHANGELOG current': read('CHANGELOG.md').match(/当前版本：\*\*(\d+\.\d+\.\d+)\*\*/)?.[1],
  // detailed log: "## [x.y.z] — date"; public brief log: "## YYYY-MM-DD · x.y.z" (latest of that day)
  'CHANGELOG first heading': read('CHANGELOG.md').match(/^## (?:\[(\d+\.\d+\.\d+)\]|\d{4}-\d{2}-\d{2} · (\d+\.\d+\.\d+))/m)?.slice(1).find(Boolean),
  ...(exists('CHANGELOG-brief.md') ? {
    'CHANGELOG-brief current': read('CHANGELOG-brief.md').match(/当前版本：\*\*(\d+\.\d+\.\d+)\*\*/)?.[1],
    'CHANGELOG-brief first heading': read('CHANGELOG-brief.md').match(/^## \d{4}-\d{2}-\d{2} · (\d+\.\d+\.\d+)/m)?.[1],
  } : {}),
};
if (!/^\d+\.\d+\.\d+$/.test(version) || Object.values(versions).some((v) => !v || v !== version)) fail('version mismatch: ' + JSON.stringify(versions));
else ok('versions: all ' + Object.keys(versions).length + ' sources = ' + version);

const ignore = existsSync(join(root, '.gitignore')) ? read('.gitignore') : '';
if (!ignore.split(/\r?\n/).some((line) => /^\/?APIKEY\.txt$/.test(line.trim()))) fail('.gitignore must explicitly ignore APIKEY.txt');
else ok('APIKEY.txt is explicitly ignored; its content is never read');
const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
const inGit = gitRoot.status === 0 && resolve(gitRoot.stdout.trim()).toLowerCase() === root.toLowerCase();
const tracked = inGit ? spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }) : null;
if (tracked && tracked.status !== 0) fail('git ls-files failed');
const scanFiles = tracked?.status === 0 ? tracked.stdout.split('\0').filter(Boolean).map(unix) : files.filter((path) => !/(?:^|\/)(?:APIKEY\.txt|\.env[^/]*|[^/]*\.key)$/.test(path) && !/^(?:coverage|test-results|playwright-report|tmp|temp)\//.test(path) && !/\.(?:tmp|temp|log|bak)$/.test(path));
let scanned = 0;
for (const path of scanFiles) {
  if (/(?:^|\/)APIKEY\.txt$/i.test(path)) {
    if (inGit) fail('APIKEY.txt is tracked; remove it from the Git index');
    continue;
  }
  if (path.split('/').some((part) => part === 'node_modules' || part === '.git') || !/\.(?:[cm]?js|ts|jsx|tsx|json|md|txt|html|css|svg|ya?ml|toml|ini|csv|tsv)$/.test(extname(path)) || !existsSync(join(root, path)) || lstatSync(join(root, path)).isSymbolicLink()) continue;
  scanned++;
  const lines = read(path).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    tokenPattern.lastIndex = 0;
    if (tokenPattern.test(lines[i])) fail(`possible credential at ${path}:${i + 1} (value redacted)`);
  }
}
ok(`secrets: scanned ${scanned} source/document files (${inGit ? 'Git tracked files' : 'no Git repository; source snapshot fallback'})`);
// Privacy: the files that ship (tools/release-files.mjs) must carry no personal markers. In the public
// repository every file ships, so the whole tree is scanned there.
{
  const { PUBLISH, RENAME, PERSONAL } = await import('./release-files.mjs');
  const devTree = exists('CHANGELOG-brief.md');
  const shipped = devTree ? files.filter((f) => [...PUBLISH, ...Object.keys(RENAME)].some((p) => f === p || f.startsWith(p + '/'))) : files;
  let hits = 0;
  for (const path of shipped) {
    if (/(?:^|\/)APIKEY\.txt$/i.test(path) || !/\.(?:[cm]?js|ts|json|md|html|css|ya?ml|txt|svg)$|(?:^|\/)\.gitignore$/.test(path)) continue;
    read(path).split(/\r?\n/).forEach((line, i) => {
      for (const p of PERSONAL) if (p.re.test(line)) { hits++; fail(`personal information (${p.name}) at ${path}:${i + 1}`); }
    });
  }
  if (!hits) ok(`privacy: ${shipped.length} published files carry no home paths, scratch paths or private ports`);
}
console.log(`\n${failures ? 'FAILED' : 'PASS'}: ${failures} errors, ${warnings} known-cycle warnings`);
process.exitCode = failures ? 1 : 0;
