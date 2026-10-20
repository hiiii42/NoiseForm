// Application keyboard commands.
import { state } from '../store.js';
import { visibleRecords, selectedIds, clearSelection, selectAllVisible, gridColumns } from '../ui/archive.js';
import { modalOpen } from '../ui/modal.js';
import { toggleAuto } from '../auto.js';
import { postActive } from '../ui/workbench.js';
import { history, userSelect, setFlag, getRecord, batchAction } from './records.js';
import { generateNow } from './generate.js';
import { runTool } from './tools.js';
import { useSeedOf } from './editor.js';
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (postActive() && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'f', 'x', 'u', 'F', 'X', 'U'].includes(e.key)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (modalOpen()) return;
      if (e.shiftKey) return toggleAuto();
      generateNow();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !modalOpen()) {
      e.preventDefault();
      const ids = selectedIds();
      return ids.length ? batchAction('zip', ids) : runTool('save');
    }
    // Esc in an editor (autocomplete already handled and prevented it) hands the keyboard back to the shortcuts
    if (e.key === 'Escape' && !e.defaultPrevented && !modalOpen() && e.target.matches?.('textarea, input:not([type=checkbox]):not([type=radio])')) {
      e.target.blur();
      return;
    }
    if (modalOpen() || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    // With a Chinese / Japanese IME active Chrome may report key "Process"; fall back to the physical key.
    let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if ((key === 'Process' || key === 'Unidentified' || (key.length === 1 && !/[ -~]/.test(key))) && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // browse what the archive shows (filters / search applied); ↑/↓ move a row in the grid
      const list = visibleRecords();
      const i = list.findIndex((r) => r.id === state.session.currentId);
      const step = key === 'ArrowUp' || key === 'ArrowDown' ? (state.settings.archWide ? gridColumns() : 1) : 1;
      const d = (key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1) * step;
      const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d))];
      e.preventDefault();
      if (next && next.id !== state.session.currentId) {
        clearSelection();
        userSelect(next.id);
      }
    } else if (key === 'f' || key === 'x' || key === 'u') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      const sel = selectedIds();
      const ids = sel.length ? sel : state.session.currentId ? [state.session.currentId] : [];
      if (!ids.length) return;
      const recs = ids.map((id) => history.find((r) => r.id === id)).filter(Boolean);
      const flag = key === 'u' ? 0 : key === 'f' ? (recs.every((r) => r.flag === 1) ? 0 : 1) : recs.every((r) => r.flag === -1) ? 0 : -1;
      setFlag(ids, flag, { advance: key === 'x' && !sel.length && flag === -1 });
    } else if (key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const id = state.session.currentId;
      if (id) getRecord(id).then(useSeedOf);
    } else if (key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      selectAllVisible();
    } else if (key === 'Escape') {
      if (clearSelection()) e.preventDefault();
    } else if (key === 'Delete') {
      const ids = selectedIds();
      if (ids.length) batchAction('delete', ids);
      else if (state.session.currentId) runTool('delete');
    }
  });
}


export { wireKeys };
