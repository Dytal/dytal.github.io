// dropdown.js — anchored dropdown panel with animated open/close.
// Behaviors from the mockup notes:
//  - INSTANCE dropdown: height fits the number of instances (capped to viewport, scrolls beyond).
//  - VERSIONS dropdown: shows max 4 rows at a time; scrolling reveals the rest.
import { el, $ } from '../utils.js';

let openDropdown = null;

export function closeDropdown(instant = false) {
  if (!openDropdown) return;
  const d = openDropdown;
  openDropdown = null;
  document.removeEventListener('mousedown', d._outside, true);
  document.removeEventListener('keydown', d._esc, true);
  d.anchor?.classList.remove('open');
  if (instant) { d.panel.remove(); return; }
  d.panel.classList.add('closing');
  setTimeout(() => d.panel.remove(), 150);
}

export function isOpen() { return !!openDropdown; }

/**
 * openDropdownPanel({ anchor, width, build(panel) })
 * `build` fills the panel and returns a content element whose height defines the panel.
 * options: { maxVisibleItems, itemHeight } to cap visible rows (versions = 4).
 */
export function openDropdownPanel({ anchor, width = null, maxVisibleItems = null, itemHeight = 40, build }) {
  closeDropdown();
  const panel = el('div', { class: 'dropdown-panel' });
  if (width) panel.style.width = typeof width === 'number' ? width + 'px' : width;

  const content = build(panel) || panel;
  // size the scrollable list: fit content, or cap at N visible rows
  const list = content ? (content.querySelector('.dd-list') || content) : null;
  if (maxVisibleItems && list) {
    // fixed cap: only N rows visible at a time (note: VERSIONS dropdown shows 4)
    list.style.maxHeight = (maxVisibleItems * itemHeight) + 'px';
  } else if (list) {
    // natural height that follows the amount of items (note: INSTANCE dropdown)
    const remeasure = () => {
      const natural = Math.max(list.scrollHeight, 0);
      list.style.maxHeight = Math.min(natural, window.innerHeight - 160) + 'px';
    };
    remeasure();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(remeasure);
      ro.observe(list);
    }
  }

  // position under anchor (clamped to viewport)
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const pw = panel.offsetWidth;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    const top = r.bottom + 6;
    const ph = panel.offsetHeight;
    const maxTop = window.innerHeight - Math.min(ph, window.innerHeight - 30) - 8;
    panel.style.left = left + 'px';
    panel.style.top = Math.min(top, Math.max(8, maxTop)) + 'px';
    panel.style.visibility = 'visible';
  });

  const outside = (e) => {
    if (!panel.contains(e.target) && !anchor.contains(e.target)) closeDropdown();
  };
  const esc = (e) => { if (e.key === 'Escape') { closeDropdown(); e.stopPropagation(); } };
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);

  anchor.classList.add('open');
  openDropdown = { panel, anchor, _outside: outside, _esc: esc };
  return panel;
}

/** Generic item row builder */
export function ddItem({ title, sub, selected, onclick, ondblclick, right }) {
  return el('div', {
    class: `dd-item ${selected ? 'selected' : ''}`,
    onclick, ondblclick,
  },
    el('span', { text: title }),
    sub ? el('span', { class: 'sub', text: sub }) : null,
    right || el('span', { class: 'check', html: ICON_CHECK }),
  );
}

const ICON_CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="M4.5 12.5l5 5 10-11"/></svg>`;
