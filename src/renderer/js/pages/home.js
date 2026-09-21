// home.js — PLAY page (minimal hero: play button + target pill + live game status)
// The dashboard ALWAYS reflects the persistent state.game (starting / running /
// exited / failed), no matter how the user got back here — logo click, Back to
// Play, or right after creating an instance. Rebuilding this page can no longer
// make it "look like I never hit play".
import { el, $, fmtBytes } from '../utils.js';
import { state, selection, on, EVENTS, api } from '../state.js';
import { toast } from '../components/toast.js';
import { ICONS } from '../utils.js';

const prevCleanup = [];

/* decorative vector ornament — wireframe cube inside slowly-drifting orbit
   rings. Pure SVG line-art (no images, no emoji), inherits theme accents. */
const ORNAMENT = `<svg class="home-ornament" viewBox="0 0 520 520" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="nx-orn" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34d3ee"/><stop offset="0.55" stop-color="#3b82f6"/><stop offset="1" stop-color="#d946ef"/>
    </linearGradient>
  </defs>
  <g class="ring-a" stroke="url(#nx-orn)">
    <circle cx="260" cy="260" r="246" stroke-width="1.4" stroke-dasharray="3 10" opacity="0.28"/>
    <circle cx="260" cy="260" r="196" stroke-width="1" stroke-dasharray="2 8" opacity="0.2"/>
  </g>
  <g class="ring-b" stroke="url(#nx-orn)">
    <circle cx="260" cy="260" r="146" stroke-width="1" stroke-dasharray="1.5 7" opacity="0.2"/>
  </g>
  <g stroke="url(#nx-orn)" stroke-width="2" stroke-linejoin="round" opacity="0.42">
    <path d="M260 148l86 50v100l-86 50-86-50V198l86-50z"/>
    <path d="M174 198l86 50 86-50" opacity="0.6"/>
    <path d="M260 248v100" opacity="0.6"/>
  </g>
  <g fill="url(#nx-orn)" opacity="0.5">
    <circle cx="260" cy="14" r="3.2"/><circle cx="506" cy="260" r="3.2"/>
    <circle cx="260" cy="506" r="3.2"/><circle cx="14" cy="260" r="3.2"/>
  </g>
</svg>`;

export async function buildHome(container) {
  // rebuild safety: detach listeners from any previous home page
  prevCleanup.forEach(fn => { try { fn(); } catch {} });
  prevCleanup.length = 0;

  /* ---- launch progress area ---- */
  const progressArea = el('div', { class: 'launch-progress', style: { display: 'none' } });

  const showProgress = (title, indeterminate = true) => {
    progressArea.style.display = 'flex';
    progressArea.innerHTML = '';
    progressArea.append(
      el('div', { class: 'progress-track' }, el('div', { class: `progress-fill ${indeterminate ? 'indeterminate' : ''}` })),
      el('div', { class: 'progress-label' }, el('span', { text: title }), el('span', { text: '' })),
    );
  };
  const updateProgress = (received, total, label = 'Downloading…') => {
    // remember the last known numbers so a rebuilt page can restore the bar
    state.game.lastProgress = { received, total, label };
    const fill = $('.progress-fill', progressArea);
    const lab = $('.progress-label span:last-child', progressArea);
    const name = $('.progress-label span:first-child', progressArea);
    if (name) name.textContent = label;
    if (!fill) return;
    fill.classList.remove('indeterminate');
    fill.style.width = (total ? Math.min(100, (received / total) * 100) : 0).toFixed(1) + '%';
    if (lab) lab.textContent = `${fmtBytes(received)} / ${fmtBytes(total)}`;
  };
  const hideProgress = () => { progressArea.style.display = 'none'; progressArea.innerHTML = ''; };

  /* ---- game status area (RUNNING banner / exited / failed) ---- */
  const statusArea = el('div', { class: 'game-status', style: { display: 'none' } });

  const stopBtn = el('button', { class: 'stop-game-btn', title: 'Stop the running Minecraft process' },
    el('span', { html: ICONS.stop }), 'STOP');
  stopBtn.addEventListener('click', async () => {
    // mark BEFORE the call so the 'exited' broadcast (which may race ahead of
    // the invoke response) is recognised as a user-stop, not a crash
    state.game.stopped = true;
    try {
      const r = await api.invoke('game:stop');
      if (r?.stopped) toast('Stopping Minecraft…', 'The game process is being shut down.');
      else {
        state.game.stopped = false;
        toast('Could not stop', r?.reason || 'No game process found.', { type: 'warn' });
      }
    } catch (e) {
      state.game.stopped = false;
      toast('Could not stop', e.message, { type: 'error' });
    }
  });

  const renderGameStatus = () => {
    const g = state.game;
    statusArea.innerHTML = '';
    statusArea.style.display = 'none';

    if (g.phase === 'running') {
      hideProgress();
      statusArea.style.display = 'flex';
      statusArea.append(
        el('div', { class: 'status-banner running' },
          el('span', { class: 'dot pulse' }),
          el('div', { class: 'status-text' },
            el('b', { text: 'Minecraft is running' }),
            el('span', { text: g.detail || 'Session in progress — the launcher can stay open.' }),
          ),
          stopBtn,
        ),
      );
    } else if (g.phase === 'starting' || g.phase === 'downloading') {
      // the progress bar carries the visuals — restore or advance it
      statusArea.style.display = 'none';
      if (progressArea.style.display === 'none') {
        showProgress(g.label || 'Preparing…', true);
        const lp = g.lastProgress;
        if (lp && g.phase === 'downloading') updateProgress(lp.received, lp.total, lp.label || g.label || 'Downloading…');
      } else if (g.label) {
        // already visible — keep the headline in sync with the current phase
        // ("Starting…" → "Checking Java 21…" → "Installing fabric …")
        const name = $('.progress-label span:first-child', progressArea);
        if (name) name.textContent = g.label;
      }
    } else if (g.phase === 'exited') {
      hideProgress();
      statusArea.style.display = 'flex';
      const crash = g.crash || null;
      const bad = g.exitCode !== null && g.exitCode !== 0 && !g.stopped;
      const banner = el('div', { class: `status-banner ${bad ? 'warn' : 'done'}` },
        el('span', { class: 'dot' }),
        el('div', { class: 'status-text' },
          el('b', { text: crash && bad ? crash.title : (bad ? `Minecraft exited with code ${g.exitCode}` : 'Minecraft session ended') }),
          el('span', { text: crash && bad
            ? (crash.detail || 'The GPU driver or the game itself crashed — a safe relaunch usually gets you right back in.')
            : (bad ? 'Something may have gone wrong — check the Logs.' : 'Ready when you are — hit PLAY again.') }),
        ),
      );
      if (bad && crash) {
        // v4.6 one-click recovery actions right on the dashboard banner
        const actions = el('div', { class: 'crash-actions', style: { display: 'flex', gap: '8px', flexShrink: '0', alignItems: 'center' } });
        actions.append(el('button', {
          class: 'btn small primary', text: 'SAFE RELAUNCH',
          title: 'Relaunch without resource packs — they are restored automatically after 10 clean minutes',
          onclick: async (ev) => {
            ev.stopPropagation();
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              await api.invoke('diag:armSafeMode', { reason: 'safe relaunch after a crash' });
              toast('Safe mode armed', 'Relaunching 100% vanilla — packs return automatically after 10 clean minutes.');
              await api.invoke('game:launch', state.game.lastLaunch || {});
            } catch (e) {
              toast('Could not relaunch', e.message, { type: 'error' });
              btn.disabled = false;
            }
          },
        }));
        if (crash.reportFile) {
          actions.append(el('button', {
            class: 'btn small', text: 'CRASH REPORT', title: 'Show the Minecraft crash report file',
            onclick: (ev) => { ev.stopPropagation(); api.invoke('app:showFile', { file: crash.reportFile }).catch(() => {}); },
          }));
        }
        banner.append(actions);
      }
      statusArea.append(banner);
    } else if (g.phase === 'failed') {
      hideProgress();
      statusArea.style.display = 'flex';
      statusArea.append(
        el('div', { class: 'status-banner error' },
          el('span', { class: 'dot' }),
          el('div', { class: 'status-text' },
            el('b', { text: 'Launch failed' }),
            el('span', { text: g.message || 'Unknown error — check the Logs.' }),
          ),
        ),
      );
    }
  };

  /* ---- play button ---- */
  const playBtn = el('button', { class: 'play-btn' },
    el('span', { class: 'play-label' }, el('span', { html: ICONS.play }), 'PLAY'),
  );
  playBtn.addEventListener('click', async () => {
    if (state.launching) return;
    if (state.game.phase === 'starting' || state.game.phase === 'downloading') return; // engine busy — STOP not PLAY
    const s = selection();
    if (!s.instance && !s.version) {
      toast('Nothing selected', 'Pick a version from VERSIONS or an instance from INSTANCE first.', { type: 'warn' });
      return;
    }
    playBtn.disabled = true;
    state.launching = true;
    state.game.lastLaunch = s.instance ? { instanceId: s.instance.id } : { versionId: s.version }; // so SAFE RELAUNCH can replay it
    showProgress('Preparing…');
    try {
      const res = await api.invoke('game:launch', s.instance ? { instanceId: s.instance.id } : { versionId: s.version });
      toast('Minecraft is starting', `${res.account?.name || 'Player'} • ${s.instance ? s.instance.name : s.version}`, { timeout: 5000 });
    } catch (e) {
      toast('Launch failed', e.message, { type: 'error', timeout: 8000 });
      hideProgress();
    } finally {
      playBtn.disabled = false;
      state.launching = false;
    }
  });

  /* ---- target pill (the only "info" on this page) ---- */
  const target = el('div', { class: 'launch-target' });
  const renderTarget = () => {
    const s = selection();
    target.innerHTML = '';
    if (s.instance) {
      target.append(
        el('span', { class: 'dot' }),
        el('span', { html: `Launching instance: <b>${s.instance.name}</b> — ${s.instance.version} • ${s.instance.loader}${s.instance.loaderVersion ? ' ' + s.instance.loaderVersion : ''}` }),
      );
    } else if (s.version) {
      target.append(
        el('span', { class: 'dot' }),
        el('span', { html: `Launching vanilla <b>${s.version}</b> — saved in <b>global .minecraft</b>` }),
      );
    } else {
      target.append(el('span', { class: 'dot', style: { background: 'var(--warn)' } }),
        el('span', { text: 'Select a version (VERSIONS) or an instance (INSTANCE) to play' }));
    }
  };
  renderTarget();

  /* ---- layout: single centered hero ---- */
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  container.append(
    el('div', { class: 'home-hero' },
      el('div', { class: 'orn-wrap', html: ORNAMENT }),
      el('div', { class: 'home-hero-content' },
        playBtn,
        target,
        statusArea,
        progressArea,
      ),
    ),
  );

  /* ---- events ---- */
  const unSel = on(EVENTS.SELECTION, renderTarget);
  const unGame = on(EVENTS.GAME, renderGameStatus);
  const unsub1 = api.on('launch:progress', (p) => {
    if (p.type && p.type.includes('installer')) updateProgress(p.received ?? p.task ?? 0, p.total ?? 0, 'Installing loader…');
    else updateProgress(p.received ?? p.task ?? 0, p.total ?? 0, 'Downloading game files…');
  });
  const unsub3 = api.on('java:progress', (p) => updateProgress(p.received, p.total, 'Downloading Java runtime…'));
  prevCleanup.push(unSel, unGame, unsub1, unsub3);

  /* first paint: reflect whatever the game is doing RIGHT NOW */
  renderGameStatus();
}
