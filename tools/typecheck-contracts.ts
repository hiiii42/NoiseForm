// Compile-only checks for shared JSDoc contracts. No runtime code is emitted.
function classify(result: GenerationResult): string {
  if (result.ok === true) return result.recs.map((r) => r.id).join(',');
  if ('skipped' in result) return 'skipped';
  if (result.stage === 'persist') return result.pendingId;
  return result.err.unknown === true ? 'unknown' : 'request';
}
function taskParams(job: Job): Params {
  if (job.kind === 'xy' || job.kind === 'tiled') return job.cells[0]?.params ?? job.snap.params;
  return job.snap.params;
}
// @ts-expect-error A persistence failure must carry its recovery handle.
const missingHandle: GenerationResult = { ok: false, stage: 'persist', err: new Error() };
// @ts-expect-error Coordinates are numeric.
const invalidCharacter: Character = { id: 'c', prompt: '', uc: '', x: '0.5', y: 0.5, enabled: true };
// @ts-expect-error Resolved seeds are numeric or draft strings, never arrays.
const invalidSeed: Params['seed'] = [];
