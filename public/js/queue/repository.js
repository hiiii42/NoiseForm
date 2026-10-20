// Queue persistence and cross-tab ownership recovery. No rendering or scheduling.
import { readVersioned, writeVersioned, validateQueue, mergeQueue, persistError } from '../persist.js';
import { left } from './policy.js';

// runtime() is read at the operation boundary; it must include the final-flush token.
export function createQueueRepository({ kv, tabs, runtime, onChange, T }) {
  const Q = { jobs: [], history: [], seq: 0 };

  let baseline = { seq: 0, jobs: [], history: [] };
  let revision = 0;
  let mutations = 0;
  let writes = Promise.resolve();
  async function flushWrites() {
    let pending;
    do { pending = writes; await pending; } while (pending !== writes);
  }

  // Serialize writes in this realm; updateRaw supplies the cross-tab transaction.
  function persist(token = runtime().running ? runtime().token : null) {
    const local = structuredClone(serialize());
    const base = structuredClone(baseline);
    // This is the next operation's logical base, including writes not committed yet.
    // A remote addition learned during a commit is NOT part of a later queued edit.
    baseline = structuredClone(local);
    const turn = ++mutations;
    writes = writes.then(async () => {
      await readDisk(); // migration / backup happens before attempting a new write
      let committed;
      await writeVersioned('queue', local, { json: false, storage: {
        get: kv.getRaw,
        set: (_key, envelope) => tabs.updateQueue((disk) => {
          if (disk && (disk.v !== 1 || !validateQueue(disk.data))) throw new TypeError('Queue changed to an invalid schema');
          const current = disk?.data || { seq: 0, jobs: [], history: [] };
          const owner = !!token;
          const data = mergeQueue(current, envelope.data, base, owner, !!disk?.runner && !owner);
          committed = { v: 1, data, revision: Math.max(revision, disk?.revision || 0) + 1,
            updatedAt: Date.now(), writer: tabs.id, runner: owner ? tabs.id : disk?.runner || null };
          return committed;
        }, token),
      } });
      revision = committed.revision;
      if (turn === mutations) {
        baseline = structuredClone(committed.data);
        adopt(committed.data);
      }
      tabs.notify('queue');
      return true;
    }).catch((error) => { persistError('queue', 'persist', error); return false; });
    return writes;
  }
  function serialize() {
    return { seq: Q.seq, jobs: Q.jobs, history: Q.history };
  }
  function adopt(data) {
    const existing = new Map([...Q.jobs, ...Q.history].map((j) => [j.id, j]));
    const keep = (j) => existing.has(j.id) ? Object.assign(existing.get(j.id), j) : j;
    Q.seq = data.seq;
    Q.jobs = data.jobs.map(keep);
    Q.history = data.history.map(keep);
  }
  async function readDisk() {
    let original;
    const storage = {
      get: async (key) => (original = await kv.getRaw(key)),
      set: (key, value) => key === 'queue'
        ? kv.updateRaw(key, (current) => JSON.stringify(current) === JSON.stringify(original) ? value : current)
        : kv.setRaw(key, value),
    };
    const data = await readVersioned('queue', { version: 1, validate: validateQueue, fallback: { seq: 0, jobs: [], history: [] }, storage, json: false });
    return { data, revision: original?.revision || 0, runner: original?.runner || null, legacy: !!original && !Object.hasOwn(original, 'v') };
  }
  async function loadQueue() {
    if (runtime().running || runtime().starting) return; // never replace a running / starting snapshot
    await flushWrites();
    const turn = mutations;
    const release = await tabs.acquireRunLock();
    let disk;
    if (release) {
      try {
        disk = await readDisk();
        // Preserve the legacy migration payload; expose recovery in memory until
        // the next edit/run. Versioned records recover durably under the run lock.
        if (!disk.legacy) {
          await recoverInterrupted(tabs.runToken());
          disk = await readDisk();
        }
      }
      finally { await release(); }
    } else disk = await readDisk();
    if (turn !== mutations || runtime().running || runtime().starting) return;
    baseline = structuredClone(disk.data);
    revision = disk.revision;
    adopt(release && disk.legacy ? { ...disk.data, jobs: recoveredJobs(disk.data.jobs) } : disk.data);
  }

  const recoveredJobs = (jobs) => jobs.map((j) => j.status !== 'running' ? j : {
    ...j, status: 'paused',
    ...(left(j) > 0 ? { stage: 'unknown', reason: T('运行中断，结果未知。请核对档案和服务端记录后移除；如需重试，请重新入队。', 'Run interrupted; result unknown. Check the archive and service records, then remove this job; enqueue again if needed.') } : {}),
  });

  // Only call while holding the actual run lock. Persistent runner IDs alone do
  // not prove liveness. An interrupted request must never be replayed on recovery.
  async function recoverInterrupted(token) {
    await tabs.updateQueue((disk) => {
      if (!disk || !validateQueue(disk.data) || (!disk.runner && !disk.data.jobs.some((j) => j.status === 'running'))) return disk;
      const jobs = recoveredJobs(disk.data.jobs);
      return { ...disk, data: { ...disk.data, jobs }, runner: null, revision: (disk.revision || 0) + 1, updatedAt: Date.now() };
    }, token);
  }
  tabs.subscribe(async (topic) => {
    if (topic !== 'queue') return;
    await flushWrites();
    const turn = mutations;
    const disk = await readDisk();
    if (turn !== mutations) return;
    if (disk.revision < revision) return;
    if (runtime().running) adopt(mergeQueue(disk.data, serialize(), baseline, true));
    else adopt(disk.data); // read-only refresh: no changed()/persist echo
    baseline = structuredClone(disk.data);
    revision = disk.revision;
    onChange();
  });

  async function prepareRun(token) {
    await flushWrites();
    await recoverInterrupted(token);
    // Refresh after ownership changes; never replay a stale, already-finished job.
    let disk, turn;
    do {
      await flushWrites();
      turn = mutations;
      disk = await readDisk();
    } while (turn !== mutations);
    adopt(mergeQueue(disk.data, serialize(), baseline, false));
    baseline = structuredClone(disk.data);
    revision = disk.revision;
  }

  async function clearRunner(token) {
    await tabs.updateQueue((disk) => disk?.runner === tabs.id
      ? { ...disk, runner: null, revision: (disk.revision || 0) + 1, updatedAt: Date.now() } : disk, token);
  }
  return { state: Q, persist, flushWrites, loadQueue, prepareRun, clearRunner };
}
