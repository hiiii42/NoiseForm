// Pure queue decisions. No state, DOM, clock, randomness or persistence access.
// History entries omit cells, so use the count captured when they were queued.
export const total = (job) => ((job.kind === 'xy' || job.kind === 'tiled') && job.cells ? job.cells.length : job.count || Infinity);
export const left = (job) => total(job) - job.done;

export function seedSource(job, history) {
  if (job.seedMode === 'prev') return history.find((x) => x.kind === 'batch' && x.seeds.length) || null;
  if (job.seedMode === 'job') return history.find((x) => x.id === job.seedFrom) || null;
  return null;
}

// Return a choice instead of drawing randomness: only the runner owns that effect.
export function seedChoice(job) {
  if (job.kind === 'xy' || job.kind === 'tiled') return { seed: job.cells[job.done].seed };
  if (job.seedMode === 'fixed') return { seed: Number(job.snap.params.seed) >>> 0 };
  if (job.srcSeeds && job.done < job.srcSeeds.length) return { seed: job.srcSeeds[job.done] };
  return { random: true };
}

// Batch settings are live, whereas grid/tiled jobs retain their explicit guard.
// Retrying storage never requires another free-generation eligibility check.
export function shouldCheckFree(job, settings, session) {
  const guard = job.kind === 'oneoff' ? false : job.kind === 'batch' ? settings.autoFreeOnly !== false : job.freeOnly;
  return !!(guard && session.live && !job.pendingSaveId);
}

/**
 * Decide how to consume one generate/retrySave result without changing the job.
 * reason is a code for the runner's existing localized messages. Counters carry
 * across jobs exactly as before (including XY failures and skipped starts).
 */
export function resultPolicy(result, { fails = 0, skips = 0, kind = 'batch' } = {}) {
  if (result?.ok) return { action: 'continue', fails: 0, skips: 0 };
  if (result?.skipped) {
    if (++skips > 20) return { action: 'fail', reason: 'skipped', fails, skips: 0 };
    return { action: 'backoff', delay: 400, fails, skips };
  }
  if (result?.stage === 'persist' || result?.err?.unknown) {
    const stage = result.stage === 'persist' ? 'persist' : 'unknown';
    return { action: 'pause', reason: stage, stage, fails, skips };
  }
  const status = result?.err?.status;
  if (status === 401 || status === 402 || status === 403) return { action: 'pause', reason: 'response', fails, skips };
  fails++;
  if (status === 429 && fails <= 6) return { action: 'backoff', delay: 3000 * fails, busy: true, fails, skips };
  if (kind === 'xy') return { action: 'skip-cell', failJob: fails >= 2, fails, skips };
  if (fails >= 2 || status === 400) return { action: 'fail', reason: 'response', fails: 0, skips };
  return { action: 'backoff', delay: 1500, fails, skips };
}
