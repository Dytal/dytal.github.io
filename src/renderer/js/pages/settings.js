// settings.js — Settings page (mockup: back, title, login, theme cards, memory slider + more)
import { el, ICONS, fmtMem } from '../utils.js';
import { api, state, saveSettings, refreshAccount } from '../state.js';
import { toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';
import { PROVIDER_LOGOS } from '../utils.js';

export async function buildSettings(container) {
  const s = state.settings;

  /* ---------- account / login ---------- */
  const accountArea = el('div', {});
  const renderAccount = async () => {
    accountArea.innerHTML = '';
    const acc = state.account;
    if (acc && acc.type === 'msa') {
      // the AVATAR must be the cropped 8x8 head (+hat layer) — never the full skin PNG
      const img = el('div', { class: 'a-fallback', text: (acc.name || 'P')[0] });
      const chip = el('div', { class: 'account-chip' },
        img,
        el('div', {},
          el('b', { text: acc.name }),
          el('div', { class: 'hint', text: 'Microsoft account • Java Edition' }),
        ),
        el('button', {
          class: 'btn small danger ghost', style: { marginLeft: 'auto' }, text: 'Logout',
          onclick: async () => { await api.invoke('auth:logout'); state.account = null; await refreshAccount(); await renderAccount(); },
        }),
      );
      accountArea.append(chip);
      api.invoke('auth:skinData', {}).then((r) => {
        if (!r || !r.url) return;
        const real = el('img', { src: r.url, alt: '' });
        img.replaceWith(real);
      }).catch(() => {});
    } else if (acc) {
      accountArea.append(el('div', { class: 'account-chip' },
        el('div', { class: 'a-fallback', text: (acc.name || 'P')[0] }),
        el('div', {},
          el('b', { text: acc.name }),
          el('div', { class: 'hint', text: 'Offline account' }),
        ),
        el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
          el('button', { class: 'btn small primary', text: 'Sign in with Microsoft', onclick: openMicrosoftLogin }),
          el('button', { class: 'btn small', text: 'Offline name', onclick: openOfflineLogin }),
        ),
      ));
    } else {
      // no active account right now — but a SAVED Microsoft login may exist on disk
      // (e.g. the silent refresh couldn't run just yet). It reconnects automatically;
      // the user must NEVER have to sign in again just because a refresh was slow.
      let saved = null;
      try { saved = await api.invoke('auth:sessionInfo'); } catch { /* engine offline */ }
      if (saved && saved.hasSavedLogin) {
        accountArea.append(el('div', { class: 'account-chip' },
          el('div', { class: 'a-fallback', text: (saved.profileName || 'M')[0] }),
          el('div', {},
            el('b', { text: saved.profileName ? `Saved session — ${saved.profileName}` : 'Saved Microsoft session' }),
            el('div', { class: 'hint', text: 'Your login is remembered in .neurax — it reconnects automatically when you launch the game.' }),
          ),
          el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
            el('button', {
              class: 'btn small primary', text: 'Reconnect now',
              onclick: async (e) => {
                const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Reconnecting…';
                try {
                  state.account = await api.invoke('auth:restore');
                  if (!state.account) throw new Error('Could not reconnect right now — your login stays saved and will retry at launch.');
                  toast('Session restored', state.account.name);
                } catch (err) { toast('Reconnect failed', err.message, { type: 'warn' }); }
                await renderAccount();
              },
            }),
            el('button', { class: 'btn small', text: 'Sign in again', onclick: openMicrosoftLogin }),
          ),
        ));
      } else {
        accountArea.append(el('div', { class: 'account-chip' },
          el('div', { class: 'a-fallback', text: '?' }),
          el('div', {}, el('b', { text: 'No account' }), el('div', { class: 'hint', text: 'Log in to play online' })),
          el('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
            el('button', { class: 'btn small primary', text: 'Sign in with Microsoft', onclick: openMicrosoftLogin }),
            el('button', { class: 'btn small', text: 'Offline name', onclick: openOfflineLogin }),
          ),
        ));
      }
    }
  };
  renderAccount();

  function openOfflineLogin() {
    const nameInput = el('input', { class: 'input', placeholder: 'Offline username…', maxlength: '16', value: state.account?.type === 'offline' ? state.account.name : '' });
    /* remembered logins from the encrypted vault — one click re-fills the name */
    const rememberedWrap = el('div', { style: { marginTop: '10px' } });
    api.invoke('vault:remembered', {}).then((list) => {
      if (!Array.isArray(list) || !list.length) return;
      rememberedWrap.append(el('div', { class: 'hint', style: { marginBottom: '6px' }, text: 'Remembered logins (encrypted vault):' }));
      const chips = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
      for (const r of list.slice(0, 6)) {
        chips.append(el('button', {
          class: 'btn small', text: r.name + (r.type === 'msa' ? ' ★' : ''),
          title: r.type === 'msa' ? 'Microsoft account — reconnect via Sign in with Microsoft' : `Offline — used ${r.uses || 1}×`,
          onclick: () => { nameInput.value = r.name; nameInput.focus(); },
        }));
      }
      rememberedWrap.append(chips);
    }).catch(() => {});
    openModal({
      title: 'Offline account',
      sub: 'Offline play needs no password and works without internet. Some servers require a real account.',
      body: el('div', {}, el('label', { class: 'label', text: 'Username' }), nameInput, rememberedWrap),
      actions: (close) => [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
        el('button', {
          class: 'btn primary', text: 'Save', onclick: async () => {
            try {
              state.account = await api.invoke('auth:offline', { name: nameInput.value });
              renderAccount();
              toast('Offline account saved', state.account.name);
              close();
            } catch (e) { toast('Error', e.message, { type: 'error' }); }
          },
        }),
      ],
    });
  }

  /* ---------- one-click Microsoft login (embedded window — no codes) ---------- */
  async function openMicrosoftLogin() {
    const body = el('div', {});
    const m = openModal({
      title: 'Sign in with Microsoft',
      sub: 'A Microsoft window will open — just sign in with your account. No code needed.',
      body,
    });
    const status = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 0' } },
      el('span', { class: 'spinner' }), el('span', { class: 'hint', text: 'Opening the Microsoft sign-in window…' }));
    body.append(status,
      el('button', {
        class: 'btn ghost', style: { marginTop: '10px' }, text: 'Cancel',
        onclick: async () => {
          try { await api.invoke('auth:msWindowCancel', {}); } catch {}
          m.close();
        },
      }),
    );

    const un = api.on('auth:msWindow', ({ stage, message }) => {
      status.innerHTML = '';
      status.append(el('span', { class: 'spinner' }), el('span', { class: 'hint', text: message || 'Waiting…' }));
    });

    try {
      state.account = await api.invoke('auth:msWindow', {});
      un();
      renderAccount();
      m.close();
      toast('Welcome, ' + state.account.name, 'Microsoft account connected. You can play online now.');
    } catch (e) {
      un();
      body.innerHTML = '';
      body.append(
        el('p', { style: { color: 'var(--danger)', lineHeight: '1.6' }, text: e.message }),
        el('div', { style: { display: 'flex', gap: '10px', marginTop: '14px' } },
          el('button', { class: 'btn primary', text: 'Try again', onclick: () => { m.close(); openMicrosoftLogin(); } }),
          el('button', { class: 'btn ghost', text: 'Use a device code instead', onclick: () => { m.close(); openDeviceCodeLogin(); } }),
        ),
        el('div', { class: 'hint', style: { marginTop: '12px', lineHeight: '1.6' },
          text: 'The device-code path needs your own free Azure client id (portal.azure.com → App registrations → "Personal Microsoft accounts only", enable "Allow public client flows").' }),
      );
    }
  }

  /* ---------- device-code fallback (custom Azure client id) ---------- */
  async function openDeviceCodeLogin() {
    const body = el('div', {});
    const m = openModal({
      title: 'Sign in with a device code',
      sub: 'Advanced path — uses your own Azure client id.',
      body,
    });
    const status = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 0' } },
      el('span', { class: 'hint', text: 'Enter your Azure client id, then start the flow.' }));
    const customInput = el('input', {
      class: 'input', placeholder: '00000000-0000-0000-0000-000000000000',
      value: state.settings.msClientId || '', style: { marginTop: '8px' },
    });
    const startBtn = el('button', {
      class: 'btn primary', style: { marginTop: '10px' }, text: 'Start device-code login',
      onclick: async () => {
        await saveSettings({ msClientId: customInput.value.trim() });
        status.innerHTML = '';
        status.append(el('span', { class: 'spinner' }), el('span', { class: 'hint', text: 'Contacting Microsoft…' }));
        try {
          state.account = await api.invoke('auth:msStart', {});
          un();
          renderAccount();
          m.close();
          toast('Welcome, ' + state.account.name, 'Microsoft account connected. You can play online now.');
        } catch (err) {
          un();
          status.innerHTML = '';
          status.append(el('p', { style: { color: 'var(--danger)', lineHeight: '1.6' }, text: err.message }));
        }
      },
    });
    body.append(customInput, startBtn, status);

    const un = api.on('auth:deviceCode', ({ userCode, verificationUri }) => {
      status.innerHTML = '';
      const copyBtn = el('button', {
        class: 'btn small', text: 'Copy code',
        onclick: async () => {
          try { await navigator.clipboard.writeText(userCode); copyBtn.textContent = 'Copied!'; }
          catch { copyBtn.textContent = userCode; }
          setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1600);
        },
      });
      status.append(
        el('div', { class: 'device-code-box' },
          el('div', { class: 'hint', text: 'The Microsoft page should have opened in your browser. Enter this code there:' }),
          el('div', { class: 'code', text: userCode }),
          el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '10px' } },
            copyBtn,
            el('button', {
              class: 'btn small', text: 'Open browser',
              onclick: () => api.invoke('app:openExternal', { url: verificationUri }),
            }),
          ),
          el('a', { href: verificationUri, target: '_blank', style: { color: 'var(--accent-bright)', fontSize: '12px' }, text: verificationUri }),
        ),
        el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'center', marginTop: '12px' } },
          el('span', { class: 'spinner' }), el('span', { class: 'hint', text: 'Waiting for approval…' })),
      );
    });
  }

  /* ---------- themes ---------- */
  const themeGrid = el('div', { class: 'settings-grid' });
  const renderThemes = () => {
    themeGrid.innerHTML = '';
    for (const t of ['emerald', 'orange', 'purple', 'cyan']) {
      themeGrid.append(el('button', {
        class: `theme-card ${state.settings.theme === t ? 'selected' : ''}`,
        dataset: { theme: t }, text: t.toUpperCase(),
        onclick: async () => { await saveSettings({ theme: t }); renderThemes(); },
      }));
    }
  };
  renderThemes();

  /* ---------- memory ---------- */
  const totalMB = state.appInfo?.totalMemoryMB || 8192;
  const slider = el('input', { type: 'range', class: 'slider', min: '1024', max: String(Math.max(2048, totalMB - 1024)), step: '256', value: String(state.settings.memoryMB) });
  const memVal = el('span', { class: 'val', text: fmtMem(state.settings.memoryMB) });
  slider.addEventListener('input', async () => {
    const v = Number(slider.value);
    slider.style.setProperty('--fill', ((v - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) * 100) + '%');
    memVal.textContent = fmtMem(v);
  });
  slider.addEventListener('change', () => saveSettings({ memoryMB: Number(slider.value) }));
  slider.style.setProperty('--fill', ((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) * 100) + '%');

  /* ---------- toggles ---------- */
  const toggle = (key, title, desc, onchange) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!state.settings[key];
    input.addEventListener('change', async () => { await saveSettings({ [key]: input.checked }); onchange && onchange(input.checked); });
    return el('div', { class: 'setting-row' },
      el('div', { class: 's-info' }, el('b', { text: title }), el('span', { text: desc })),
      el('label', { class: 'switch' }, input, el('span', { class: 'track' }, el('span', { class: 'thumb' }))),
    );
  };

  /* ---------- java ---------- */
  const javaList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } });
  const discoverBtn = el('button', { class: 'btn small', text: 'Rescan' });
  const runJavaScan = async (fresh) => {
    discoverBtn.disabled = true; javaList.innerHTML = '';
    javaList.append(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, el('span', { class: 'spinner' }), el('span', { class: 'hint', text: 'Scanning…' })));
    try {
      const javas = await api.invoke('java:discover', { fresh });
      javaList.innerHTML = '';
      if (!javas.length) {
        javaList.append(el('span', { class: 'hint', text: 'No Java found on this PC — Neurax auto-downloads the right one when you hit PLAY, saves it, and reuses it from then on.' }));
      }
      for (const j of javas) {
        const tag = j.source === 'neurax' ? 'saved by Neurax' : j.source === 'override' ? 'set in Settings' : 'system';
        javaList.append(el('div', { class: 'chip', style: { justifyContent: 'flex-start' } },
          el('b', { text: `Java ${j.major}` }),
          el('span', { style: { opacity: '.6', fontSize: '11px', whiteSpace: 'nowrap' }, text: tag }),
          el('span', { text: j.path })));
      }
    } catch (e) { javaList.innerHTML = ''; javaList.append(el('span', { class: 'hint', text: e.message })); }
    discoverBtn.disabled = false;
  };
  discoverBtn.addEventListener('click', () => runJavaScan(true));
  runJavaScan(false); // first paint uses the cached scan — instant

  /* ---------- advanced: custom Microsoft client id ---------- */
  const msRow = el('div', { class: 'setting-row' },
    el('div', { class: 's-info' },
      el('b', { text: 'Microsoft client id' }),
      el('span', { text: state.settings.msClientId ? `Custom: ${state.settings.msClientId.slice(0, 8)}…` : 'Built-in default (works out of the box)' })),
    el('button', {
      class: 'btn small', text: 'Change',
      onclick: () => {
        const input = el('input', { class: 'input', placeholder: 'Paste custom Azure client id (or clear to use built-in)', value: state.settings.msClientId || '', style: { marginTop: '10px' } });
        const m = openModal({
          title: 'Microsoft client id',
          sub: 'Optional override. Leave empty to use the built-in default.',
          body: input,
          actions: (close) => [
            el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
            el('button', {
              class: 'btn primary', text: 'Save', onclick: async () => {
                await saveSettings({ msClientId: input.value.trim() });
                close();
                toast('Saved', input.value.trim() ? 'Custom client id set.' : 'Using built-in client id.');
                msRow.querySelector('.s-info span').textContent = state.settings.msClientId ? `Custom: ${state.settings.msClientId.slice(0, 8)}…` : 'Built-in default (works out of the box)';
              },
            }),
          ],
        });
      },
    }),
  );

  /* ---------- NX Cloud (background — nothing to configure) ---------- */
  const nxStatus = el('span', { class: 'hint', text: 'Checking NX Cloud…' });
  const renderNx = async () => {
    try {
      const st = await api.invoke('nx:status');
      if (st.connected && st.needsSchema) {
        nxStatus.textContent = 'Database reachable but TABLES MISSING — run supabase/nx-supabase-setup.sql in the Supabase SQL editor, then restart the launcher.';
        nxStatus.style.color = '#f59e0b';
      } else if (st.connected) {
        const via = st.mode === 'supabase' ? (st.via === 'pooler' ? `via IPv4 pooler (${st.viaHost})` : 'direct connection') : 'legacy nx-cloud server';
        nxStatus.textContent = `Connected ${via} — ${st.online} online · ${st.total} total${st.queued ? ' · ' + st.queued + ' queued' : ''}`;
        nxStatus.style.color = 'var(--accent-bright, #34d399)';
      } else {
        nxStatus.textContent = `Not connected${st.lastError ? ' · ' + st.lastError : ''} — chats and announcements keep working from cache meanwhile.`;
        nxStatus.style.color = 'var(--muted)';
      }
    } catch { nxStatus.textContent = 'Engine unavailable.'; }
  };
  const nxCard = el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('label', { class: 'label', text: 'NX Cloud — runs automatically in the background' }),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' },
        el('b', { text: 'Status (auto-refreshes every 5s)' }),
        nxStatus),
      el('button', { class: 'btn small', text: 'Refresh', onclick: renderNx }),
    ),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' },
        el('b', { text: 'Admin panel' }),
        el('span', { text: 'Locked. Unlock it on the ANNOUNCEMENTS tab with the owner passkey — only the owner has it. The NEURAX CONTROL CENTER logs in with the built-in owner admin key.' })),
    ),
    toggle('nxUiInject', 'NX-UI 64x resource pack', 'Auto-inject the futuristic 64x UI pack into every instance (buttons, sliders, checkboxes, scrollbars, tooltips).'),
    el('div', { class: 'hint', style: { marginTop: '10px' }, text: 'Everything else is fully automatic: cloud sync, chat, announcements and the hidden device-bound UUID work in the background on your own Supabase database. Publish announcements and lock/unlock devices from the NEURAX CONTROL CENTER (nx-cloud → START-CONTROL-CENTER.bat) — it logs in with the built-in owner admin key.' }),
  );

  /* ---------- encrypted memory vault status (Storage & about) ---------- */
  const vaultStatus = el('span', { text: 'Checking…' });
  api.invoke('vault:status', {}).then((v) => {
    if (!v) { vaultStatus.textContent = 'Unavailable.'; return; }
    const when = v.updatedAt ? new Date(v.updatedAt).toLocaleString() : '—';
    vaultStatus.textContent = `${v.encrypted} · file locked READ-ONLY · remembers ${v.logins} login(s) · updated ${when}`;
  }).catch(() => { vaultStatus.textContent = 'Unavailable.'; });

  /* ---------- layout ---------- */
  container.append(
    el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' } },
      el('button', { class: 'btn', html: `${ICONS.back} <span style="margin-left:6px">BACK</span>`, onclick: () => { import('../router.js').then(r => r.navigate('home', { forward: false })); } }),
      el('div', { class: 'page-title', style: { margin: '0' }, text: 'SETTINGS' }),
      el('button', { class: 'btn primary', text: state.account?.type === 'msa' ? 'ACCOUNT' : 'LOGIN', onclick: openMicrosoftLogin }),
    ),
    el('div', { class: 'settings-wrap' },
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('label', { class: 'label', text: 'Account' }),
        accountArea,
        el('div', { class: 'hint', style: { marginTop: '10px' }, text: 'Sign in with Microsoft plays online with your own username, skin and UUID. Offline mode needs no internet.' }),
      ),
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('label', { class: 'label', text: 'Theme' }),
        themeGrid,
        el('div', { style: { height: '22px' } }),
        el('div', { class: 'mem-head', style: { display: 'flex', justifyContent: 'space-between' } },
          el('span', { class: 'label', style: { margin: '0' }, text: 'Memory slider / total memory' }), memVal),
        slider,
        el('div', { class: 'hint', style: { textAlign: 'right', marginTop: '4px' }, text: `Total: ${(totalMB / 1024).toFixed(0)} GB — used for instances & the game` }),
      ),
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('label', { class: 'label', text: 'Behaviour' }),
        toggle('keepLauncherOpen', 'Keep launcher open', 'Leave the launcher running while Minecraft plays.'),
        toggle('playFullscreen', 'Start Minecraft fullscreen', 'Game window opens in fullscreen mode.'),
        toggle('showSnapshots', 'Show snapshots', 'Include snapshot versions in the VERSIONS menu.'),
        toggle('showOldVersions', 'Show Beta & Alpha', 'Include historic versions in the VERSIONS menu.'),
        toggle('rememberWindowSize', 'Remember window size', 'Reopen the launcher at its last size (default 1200×800).'),
      ),
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('label', { class: 'label', text: 'Java' }),
        el('div', { class: 'setting-row' },
          el('div', { class: 's-info' }, el('b', { text: 'Auto-managed runtimes' }),
            el('span', { text: 'Your installed JDKs (JAVA_HOME, PATH, Program Files) are always used first when they match. Only if nothing fits does Neurax auto-download the right Java (8/16/17/21/25) into .neurax/runtimes — once — and reuse it on every future launch. MC 26.1+ uses Java 25.' })),
        ),
        el('div', { class: 'setting-row' },
          el('div', { class: 's-info' }, el('b', { text: 'Discovered runtimes' }), javaList),
          discoverBtn,
        ),
      ),
      nxCard,
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('label', { class: 'label', text: 'Advanced' }),
        msRow,
      ),
      el('div', { class: 'card' },
        el('label', { class: 'label', text: 'Storage & about' }),
        el('div', { class: 'setting-row' },
          el('div', { class: 's-info' }, el('b', { text: 'Data folder' }),
            el('span', { text: state.appInfo?.neuraxRoot || '' })),
          el('button', { class: 'btn small', text: 'Open', onclick: () => api.invoke('app:openFolder', {}) }),
        ),
        el('div', { class: 'setting-row' },
          el('div', { class: 's-info' }, el('b', { text: 'Encrypted memory vault' }),
            vaultStatus),
        ),
        el('div', { class: 'setting-row' },
          el('div', { class: 's-info' }, el('b', { text: 'Clear cached metadata' }),
            el('span', { text: 'Version manifests & API caches (downloads are kept).' })),
          el('button', {
            class: 'btn small danger ghost', text: 'Clear',
            onclick: async () => { await api.invoke('app:clearCache'); toast('Cache cleared', ''); },
          }),
        ),
        el('div', { class: 'setting-row' },
          el('div', { class: 's-info' }, el('b', { text: `Neurax Launcher v${state.appInfo?.version || '2.0.0'}` }),
            el('span', { text: 'By Anish Sandeep Bharagav — all versions & snapshots auto-update from Mojang.' })),
          el('div', { style: { display: 'flex', gap: '8px' } },
            el('span', { class: 'logo', style: { width: '22px', display: 'inline-flex' }, html: PROVIDER_LOGOS.modrinth })),
        ),
      ),
    ),
  );

  await refreshAccount().then(renderAccount).catch(() => {});
}
