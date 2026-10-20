// @ts-check
// Explicit inputs only: shared by panel compatibility wrappers and application commands.
export const generationSpec = (ctx, current, lang) => ({
  params: ctx?.params || current.params,
  base: ctx ? ctx.base : current.base,
  refs: (ctx ? ctx.refs : current.refs) || [],
  vibes: (ctx ? ctx.vibes : current.vibes) || [],
  nSamples: ctx?.nSamples,
  lang,
});
export const vibeKey = (modelId, ie) => `${modelId}@${Number(ie).toFixed(2)}`;
