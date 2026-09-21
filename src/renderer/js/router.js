// router.js — animated page switching with direction-aware transitions
import { el, ICONS } from './utils.js';

const pages = new Map(); // id -> build(container)
let current = null;
let currentEl = null;
let navSeq = 0;

export function registerPage(id, build) { pages.set(id, build); }

export function currentPage() { return current; }

/**
 * navigate('servers', { forward: true, params: {...} })
 *
 * Navigating to the page that is ALREADY on screen does NOT rebuild it by
 * default — rebuilding would wipe live UI state (e.g. the launch progress bar
 * on the home/play page). Callers that really want a fresh render (list
 * refresh, new params) pass { force: true }.
 */
export async function navigate(id, { forward = true, params = {}, force = false } = {}) {
  const build = pages.get(id);
  if (!build) { console.warn('unknown page', id); return; }
  const host = document.getElementById('page-host');
  if (!host) return;

  // same-page navigation: keep the current page as-is, just scroll to top
  if (!force && current === id && currentEl && !currentEl.dataset.buildError) {
    scrollToTop();
    return;
  }

  const seq = ++navSeq;

  const old = currentEl;
  const container = el('div', { class: `page ${forward ? 'forward-enter' : 'back-enter'}`, 'data-page': id });
  container.style.padding = id.startsWith('store-') ? '0' : '';
  current = id;
  currentEl = container;

  try {
    await build(container, params);
  } catch (e) {
    console.error('page build failed', id, e);
    currentEl.dataset.buildError = '1';
    container.append(el('div', { class: 'empty-state', style: { paddingTop: '80px' } },
      el('div', { class: 'icon', html: ICONS.warn }),
      el('h3', { text: 'Something went wrong' }),
      el('p', { text: e.message || String(e) }),
    ));
  }
  if (seq !== navSeq) return; // superseded

  host.append(container);
  if (old) {
    // strip the enter animation classes first — their `fill: both` final state
    // would otherwise override the exit animation (same specificity, later rule)
    // and leave the old page fully visible UNDER the new one for the whole
    // transition (visible through the new page's card gaps).
    old.classList.remove('forward-enter', 'back-enter');
    old.classList.add(forward ? 'forward-exit' : 'back-exit');
    setTimeout(() => old.remove(), 240);
  }
  container.scrollTop = 0;
}

export function scrollToTop() { currentEl?.scrollTo({ top: 0, behavior: 'smooth' }); }
