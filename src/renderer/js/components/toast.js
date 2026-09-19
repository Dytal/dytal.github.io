// toast.js — toast notifications + progress toasts
import { el, ICONS } from '../utils.js';

let host = null;
function ensureHost() {
  if (!host) {
    host = el('div', { id: 'toast-host' });
    document.body.append(host);
  }
  return host;
}

export function toast(title, msg = '', { type = 'info', timeout = 4200 } = {}) {
  ensureHost();
  const close = () => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 260);
  };
  const t = el('div', { class: `toast ${type}` },
    el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { class: 't-title', text: title }),
      msg ? el('div', { class: 't-msg', text: msg }) : null,
    ),
    el('button', { class: 't-close', onclick: close, html: ICONS.x, title: 'Dismiss' }),
  );
  host.append(t);
  if (timeout) setTimeout(close, timeout);
  return { close, node: t };
}

/** Progress toast; returns { update(received, total, label), done(), fail(msg) } */
export function progressToast(title, indeterminate = true) {
  ensureHost();
  const fill = el('div', { class: `progress-fill ${indeterminate ? 'indeterminate' : ''}` });
  const label = el('div', { class: 'progress-label' }, el('span', { text: '' }), el('span', { text: '' }));
  const t = el('div', { class: 'toast' },
    el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { class: 't-title', text: title }),
      el('div', { class: 'progress-track', style: { marginTop: '9px' } }, fill),
      label,
    ),
  );
  host.append(t);
  const api = {
    node: t,
    update(received, total, rightLabel = '') {
      fill.classList.remove('indeterminate');
      const pct = total ? Math.min(100, (received / total) * 100) : 0;
      fill.style.width = pct.toFixed(1) + '%';
      label.children[0].textContent = rightLabel;
      label.children[1].textContent = pct.toFixed(0) + '%';
    },
    count(done, total, rightLabel = '') {
      fill.classList.remove('indeterminate');
      fill.style.width = (total ? (done / total) * 100 : 0).toFixed(1) + '%';
      label.children[0].textContent = rightLabel;
      label.children[1].textContent = `${done}/${total}`;
    },
    /** phase text without touching the bar (e.g. "Applying overrides…") */
    status(msg) {
      label.children[0].textContent = msg;
      label.children[1].textContent = '';
    },
    done(msg = 'Done') {
      fill.classList.remove('indeterminate');
      fill.style.width = '100%';
      label.children[0].textContent = msg;
      label.children[1].textContent = '';
      setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, 2200);
    },
    fail(msg) {
      t.classList.add('error');
      label.children[0].textContent = msg;
      fill.style.background = 'var(--danger)';
      setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, 4200);
    },
    close() { t.remove(); },
  };
  return api;
}
