// logs.js — logs popup window logic
import { el } from './utils.js';

const consoleEl = document.getElementById('console');
const filtersEl = document.getElementById('filters');
const countEl = document.getElementById('count');
const clearBtn = document.getElementById('clear');

let lines = [];
let filter = 'all';
const FILTERS = ['all', 'launcher', 'game', 'download', 'error'];
const SOURCES = { launcher: ['info', 'warn', 'debug'], game: ['game'], download: ['download'], error: ['error'] };

function render() {
  consoleEl.innerHTML = '';
  const shown = lines.filter(l => filter === 'all' || SOURCES[filter].includes(l.level));
  for (const l of shown.slice(-800)) {
    consoleEl.append(el('div', { class: `log-line ${l.level}` },
      el('span', { class: 't', text: l.time.slice(11, 19) }),
      `[${l.source}] `,
      l.msg,
    ));
  }
  countEl.textContent = `${shown.length} lines`;
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function renderFilters() {
  filtersEl.innerHTML = '';
  for (const f of FILTERS) {
    filtersEl.append(el('button', {
      class: `btn small ${filter === f ? 'primary' : 'ghost'}`, text: f,
      onclick: () => { filter = f; renderFilters(); render(); },
    }));
  }
}

renderFilters();

try {
  const history = await window.neurax.invoke('logs:history');
  if (Array.isArray(history)) lines = history;
  render();
} catch {}

window.neurax.on('logs:entry', (entry) => {
  lines.push(entry);
  if (lines.length > 4000) lines.shift();
  if (filter === 'all' || SOURCES[filter]?.includes(entry.level)) {
    consoleEl.append(el('div', { class: `log-line ${entry.level}` },
      el('span', { class: 't', text: entry.time.slice(11, 19) }),
      `[${entry.source}] `,
      entry.msg,
    ));
    countEl.textContent = `${consoleEl.children.length} lines`;
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
});

clearBtn.addEventListener('click', () => { lines = []; render(); });
