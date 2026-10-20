export default async ({ page, assert, log }) => {
  const orphan = await page.run(async () => {
    const { kv } = await import('/js/db.js'), { createTabCoordinator } = await import('/js/tabs.js');
    await kv.setRaw('queue.runLock', { v: 1, data: { owner: 'terminated-owner' } });
    const c = createTabCoordinator({ locks: null, channelName: 'nf:orphan-test' });
    const release = await c.acquireRunLock();
    await c.close(); return !!release;
  });
  assert.equal(orphan, true, 'legacy orphan must be reclaimable');
  const result = await page.run(async () => {
    const { kv } = await import('/js/db.js'), { createTabCoordinator } = await import('/js/tabs.js');
    let clock = Date.now();
    const opts = { locks: null, channelName: 'nf:fence-test', leaseMs: 100, heartbeatMs: 10000, now: () => clock };
    const a = createTabCoordinator(opts), b = createTabCoordinator(opts);
    const releaseA = await a.acquireRunLock();
    const tokenA = a.runToken();
    const denied = await b.acquireRunLock();
    clock += 101; // A is suspended: no heartbeat, then B takes over.
    const releaseB = await b.acquireRunLock();
    const tokenB = b.runToken();
    let fenced = false;
    try { await a.updateQueue(disk => ({ ...disk, staleWrite: true }), tokenA); }
    catch { fenced = true; }
    const oldAlive = await a.checkRunLock(tokenA);
    await releaseA();
    const newAlive = await b.checkRunLock(tokenB);
    const disk = await kv.getRaw('queue');
    await releaseB?.(); await a.close(); await b.close();
    return { denied: !denied, acquired: !!releaseB, distinct: tokenA !== tokenB, fenced, oldAlive, newAlive, staleWrite: !!disk?.staleWrite };
  });
  assert.deepEqual(result, { denied: true, acquired: true, distinct: true, fenced: true, oldAlive: false, newAlive: true, staleWrite: false });
  const heartbeat = await page.run(async () => {
    const { createTabCoordinator } = await import('/js/tabs.js');
    const opts = { locks: null, channelName: 'nf:heartbeat-test', leaseMs: 240, heartbeatMs: 40 };
    const a = createTabCoordinator(opts), b = createTabCoordinator(opts);
    await a.acquireRunLock();
    await new Promise(resolve => setTimeout(resolve, 650));
    const stolen = !!await b.acquireRunLock();
    await a.close();
    const recovered = !!await b.acquireRunLock();
    await b.close(); return { stolen, recovered };
  });
  assert.deepEqual(heartbeat, { stolen: false, recovered: true }, 'heartbeats keep a live owner exclusive beyond one lease');
  log('Orphan recovery, live-lease exclusion, expired takeover and old-owner write/release fencing.');
};
