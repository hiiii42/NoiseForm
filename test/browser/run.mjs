// Runs test/browser/*.spec.mjs (or the files given as args) one by one, each with a fresh server + Chrome.
// A spec: export default async ({ page, server, url, assert, log }) => {}; export const options = { allowProxy, init, env, width, height }
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ROOT, ARTIFACTS, artifact, startServer, launch, chromePath } from './harness.mjs';

const dir = join(ROOT, 'test', 'browser');
const list = process.argv.includes('--list');
const filter = process.argv.slice(2).filter((arg) => arg !== '--list');
const specs = readdirSync(dir).filter((f) => f.endsWith('.spec.mjs')).filter((f) => !filter.length || filter.some((x) => f.includes(x))).sort();
if (list) {
  console.log(specs.join('\n'));
  process.exit(specs.length ? 0 : 1);
}
process.once('exit', () => console.log('Browser test artifacts: ' + ARTIFACTS));
if (!specs.length) {
  console.error('No browser specs matched: ' + filter.join(', '));
  process.exit(1);
}
if (!chromePath()) {
  console.log('SKIP browser tests: Chrome not found (set CHROME=path)');
  process.exit(process.env.CI_REQUIRE_BROWSER ? 1 : 0);
}
let failed = 0;
for (const f of specs) {
  let server;
  let page;
  let specFailed = false;
  const lines = [];
  const log = (s) => lines.push('    ' + s);
  const t0 = Date.now();
  try {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    const o = mod.options || {};
    server = await startServer(o.env || {});
    page = await launch({ ...o });
    await page.goto(server.url, o.settle ?? 2500);
    await mod.default({ page, server, url: server.url, assert, log, artifact });
    if (!o.allowPageErrors && page.errors.length) throw new Error('page errors:\n' + page.errors.join('\n'));
    console.log(`ok   ${basename(f)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    specFailed = true;
    console.log(`FAIL ${basename(f)}\n    ${(err.stack || err).toString().split('\n').slice(0, 6).join('\n    ')}`);
    if (page) {
      try {
        const path = artifact('failures/' + basename(f) + '.png');
        await page.shot(path);
        console.log('    screenshot: ' + path);
      } catch (error) { console.log('    screenshot unavailable: ' + error.message); }
      if (page.logs.length) console.log('    -- page log --\n    ' + page.logs.slice(-15).join('\n    '));
    }
  } finally {
    if (lines.length) console.log(lines.join('\n'));
    const cleanup = await Promise.allSettled([page?.close(), server?.stop()]);
    for (const result of cleanup) if (result.status === 'rejected') {
      specFailed = true;
      console.error('    cleanup failed: ' + result.reason);
    }
  }
  if (specFailed) failed++;
}
console.log(`\n${specs.length - failed}/${specs.length} browser specs passed`);
process.exitCode = failed ? 1 : 0;
