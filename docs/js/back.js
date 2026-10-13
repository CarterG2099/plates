/**
 * back.js — the phone's back gesture steps back through the app instead of
 * leaving it.
 *
 * An installed PWA has one page and, until now, one history entry, so Android's
 * back closed the app from anywhere: mid-sheet, mid-workout, two tabs in. Every
 * step a person would expect back to undo — a sheet opening, the log panel
 * opening, a tab change — now pushes an entry, and back pops it by undoing that
 * step: the top sheet closes, the panel closes, the previous tab returns. Only
 * back from Today with nothing open leaves the app.
 *
 * Generic on purpose. Sheets are counted, not registered: there are dozens and
 * each closes itself on a tap of its backdrop, so "close the top layer" is the
 * same act for all of them and a new sheet needs no wiring here.
 *
 * Each history entry records { view, layers } — the tab and how many layers were
 * open — so a pop knows exactly what to restore. A layer closed some other way
 * (×, a swipe, saving) takes its entry back off the stack, so the next back press
 * does not land on a sheet that is already gone.
 */

/**
 * @param {object} env
 * @param {History} env.history     window.history, or a fake under test
 * @param {() => number} env.layers how many layers are open now
 * @param {() => void} env.closeTop close the topmost layer
 * @param {() => string} env.getView
 * @param {(view: string) => void} env.setView
 */
export function backStack({ history, layers, closeTop, getView, setView }) {
  let depth = layers();
  let view = getView();
  let ignore = 0;          // pops we caused ourselves, to be swallowed

  history.replaceState({ plates: true, view, layers: depth }, '');

  /** Call after anything that might have opened or closed a layer or changed tab. */
  function sync() {
    const n = layers();
    const v = getView();

    if (n < depth) {
      // Closed by the UI, not by back: drop the entries for the closed layers.
      // One go() fires one popstate however far it travels.
      ignore += 1;
      history.go(n - depth);
      depth = n;
      return;
    }

    if (n > depth) {
      // One entry per new layer, so back closes them one at a time.
      for (let i = depth + 1; i <= n; i++) history.pushState({ plates: true, view: v, layers: i }, '');
      depth = n;
      view = v;
    } else if (v !== view) {
      history.pushState({ plates: true, view: v, layers: n }, '');
      view = v;
    }
  }

  /** The popstate handler. */
  function onPop(event) {
    if (ignore > 0) { ignore -= 1; return; }

    const target = event.state?.plates ? event.state : { view: 'today', layers: 0 };

    // Record the destination first, so the sync that follows the close sees
    // nothing to do rather than mistaking it for a close made by hand.
    const closing = Math.max(0, depth - target.layers);
    depth = Math.min(depth, target.layers);
    view = target.view;

    if (closing > 0) closeTop();
    else if (getView() !== target.view) setView(target.view);
  }

  return { sync, onPop, get depth() { return depth; } };
}

/**
 * The topmost open sheet: the highest stacking order, and among equals the last
 * in the document, which is the one painted on top.
 */
export function topBackdrop(doc, getZ) {
  const all = [...doc.querySelectorAll('.sheet-backdrop')];
  let top = null;
  let topZ = -Infinity;
  for (const el of all) {
    const z = Number(getZ(el)) || 0;
    if (z >= topZ) { top = el; topZ = z; }
  }
  return top;
}
