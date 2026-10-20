// User-facing tool interactions are explicit ports; rendering follows application events.
import { on } from '../app/events.js';
import { refreshAll, setBaseImage, addVibe, addRef, renderChars } from './panel.js';
import { startDeveloping, urlFor } from './stage.js';
import { compareOpen } from './compare.js';
import { openInpaint } from './inpaint.js';
import { openDirector } from './director.js';
import { openEnhance, applyMetadata, applySeed } from './dialogs.js';
import { confirmDialog } from './modal.js';
import { openTiled } from './tiled.js';
export const toolPorts = { setBaseImage, addVibe, addRef, urlFor, compareOpen, openInpaint,
  openDirector, openEnhance, applyMetadata, applySeed, confirmDialog, openTiled };
export function initToolView() {
  let dev;
  const off = [
    on('tools:refresh', refreshAll), on('tools:chars', renderChars),
    on('tool:start', (info) => { dev = startDeveloping(info); }),
    on('tool:progress', (p) => dev?.setProgress(p)),
    on('generation:stop', () => { dev = null; }),
  ];
  return () => off.forEach((remove) => remove());
}
