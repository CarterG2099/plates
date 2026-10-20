/**
 * app.js loaded for real, with its Alpine stores and screen components.
 *
 * Nothing mounts a DOM: the stores and components are driven directly, so the
 * handlers under test are the ones the page runs, not copies. Alpine touches a
 * little more of the browser on import than helpers/browser.mjs provides, and
 * its start() would walk a document there isn't — both handled here.
 *
 * `components` holds each Alpine.data factory by name; call one and wrap it in
 * Alpine.reactive to get a component as the page would have it.
 */
import { installBrowser } from './browser.mjs';

let loaded = null;

export async function loadApp() {
  if (loaded) return loaded;
  installBrowser();

  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.Element = window.Element = class {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.history = window.history = { state: null, replaceState() {}, pushState() {}, back() {} };

  const Alpine = (await import('../../docs/js/vendor/alpine.esm.js')).default;
  Alpine.start = () => {};
  const components = {};
  const register = Alpine.data;
  Alpine.data = (name, factory) => { components[name] = factory; return register(name, factory); };

  await import('../../docs/js/app.js');
  loaded = { Alpine, components };
  return loaded;
}
