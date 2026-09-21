// modal.js — modal dialogs
import { el } from '../utils.js';

export function openModal({ title, sub, body, actions, onClose }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  let closed = false;
  const close = () => {
    if (closed) return; // idempotent — action buttons may close AND resolve first
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', escHandler);
    onClose && onClose();
  };
  const modal = el('div', { class: 'modal' },
    el('h2', { text: title }),
    sub ? el('div', { class: 'modal-sub', text: sub }) : null,
    body || null,
    actions ? el('div', { class: 'modal-actions' }, actions(close)) : null,
  );
  modal.addEventListener('click', (e) => e.stopPropagation());
  backdrop.append(modal);
  backdrop.addEventListener('click', close);
  const escHandler = (e) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
  document.body.append(backdrop);
  return { close, modal };
}

export function confirmModal({ title, message, confirmLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    let decided = false;
    openModal({
      title,
      body: el('p', { style: { color: 'var(--muted)', lineHeight: '1.6' }, text: message }),
      actions: (close) => [
        el('button', { class: 'btn ghost', onclick: () => { decided = false; close(); }, text: 'Cancel' }),
        el('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          onclick: () => { decided = true; close(); }, text: confirmLabel,
        }),
      ],
      onClose: () => resolve(decided),
    });
  });
}
