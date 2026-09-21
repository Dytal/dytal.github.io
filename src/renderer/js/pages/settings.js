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

  /* ---------- v4.3 DEFAULT Microsoft login: SIGN-IN WINDOW ----------
     The only flow the official Minecraft app id supports out of the box:
     an embedded Microsoft window (2FA, passkeys and saved sessions all
     work) that lands on oauth20_desktop.srf — the ONE redirect that client
     has registered. History: the v4.1.0 loopback browser default was
     refused with invalid_request (no localhost redirect registered) and
     the v4.2 device-code default was refused with AADSTS700016 (consumer
     MSA apps are not Entra-ID directory apps) — both advanced paths now
     require the owner's own Azure client id. */
  function openMicrosoftLogin() { return openPopupLogin(); }

  /* ---------- system-browser PKCE (advanced — needs your own Azure app id) ----------
     The Prism/ATLauncher method: your default browser + a one-shot localhost
     listener. The built-in Minecraft app id does NOT allow localhost
     redirects, so this only runs when the owner configured their own Azure
     client id (NX Admin → Device & login IDs). */
  async function openBrowserLogin() {
    const body = el('div', {});
    const m = openModal({
      title: 'Browser sign-in (advanced)',
      sub: 'Opens the Microsoft sign-in in your default browser and catches the result locally. Requires your own Azure client id with http://localhost allowed (set it below or in NX Admin → Device & login IDs).',
      body,
    });
    const status = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0' } },
      el('span', { class: 'spinner' }), el('span', { class: 'hint', style: { lineHeight: '1.5', wordBreak: 'break-word' }, text: 'Opening Microsoft sign-in in your default browser…' }));
    body.append(status,
      el('button', {
        class: 'btn ghost', style: { marginTop: '10px' }, text: 'Cancel',
        onclick: async () => {
          try { await api.invoke('auth:msBrowserCancel', {}); } catch {}
          m.close();
        },
      }),
    );

    const un = api.on('auth:msBrowser', ({ stage, message }) => {
      status.innerHTML = '';
      status.append(el('span', { class: 'spinner' }), el('span', { class: 'hint', style: { lineHeight: '1.5', wordBreak: 'break-word' }, text: message || 'Waiting for you to finish in the browser…' }));
    });

    try {
      state.account = await api.invoke('auth:msBrowser', {});
      un();
      renderAccount();
      m.close();
      toast('Welcome, ' + state.account.name, 'Microsoft account connected. You can play online now.');
    } catch (e) {
      un();
      body.innerHTML = '';
      body.append(
        el('p', { style: { color: 'var(--danger)', lineHeight: '1.6', wordBreak: 'break-word' }, text: e.message }),
        el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' } },
          el('button', { class: 'btn primary', text: 'Use the sign-in window (recommended)', onclick: () => { m.close(); openPopupLogin(); } }),
          el('button', { class: 'btn ghost', text: 'Try again', onclick: () => { m.close(); openBrowserLogin(); } }),
        ),
        el('div', { class: 'hint', style: { marginTop: '12px', lineHeight: '1.6' },
          text: 'The browser flow is for owners who registered their own free Azure app (portal.azure.com → App registrations → "Personal Microsoft accounts only" → add http://localhost under Mobile and desktop platforms → enable "Allow public client flows"). The official Minecraft app id only supports the sign-in window.' }),
      );
    }
  }

  /* ---------- v4.3 DEFAULT: embedded sign-in window (no codes, no browser) ---------- */
  async function openPopupLogin() {
    const body = el('div', {});
    const m = openModal({
      title: 'Sign in with Microsoft',
      sub: 'A Microsoft window opens inside Neurax — just sign in. 2FA, passkeys and saved accounts all work, and nothing to configure: this is the method the official Minecraft app id supports.',
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
        el('p', { style: { color: 'var(--danger)', lineHeight: '1.6', wordBreak: 'break-word' }, text: e.message }),
        el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' } },
          el('button', { class: 'btn primary', text: 'Try again', onclick: () => { m.close(); openPopupLogin(); } }),
          el('button', { class: 'btn ghost', text: 'Advanced sign-in options', onclick: () => { m.close(); openAdvancedLogin(); } }),
        ),
        el('div', { class: 'hint', style: { marginTop: '12px', lineHeight: '1.6' },
          text: 'The sign-in window is the only method the official Minecraft app id supports. Device codes and the browser flow need your own free Azure app id (portal.azure.com → App registrations).' }),
      );
    }
  }

  /* ---------- advanced chooser: the two custom-Azure-id paths ---------- */
  function openAdvancedLogin() {
    const m = openModal({
      title: 'Advanced sign-in options',
      sub: 'These paths require your own free Azure app id — the official Minecraft app id only supports the sign-in window.',
      body: el('div', {},
        el('button', { class: 'btn', style: { width: '100%', justifyContent: 'flex-start' }, text: 'Device code — enter a code at microsoft.com/link', onclick: () => { m.close(); openDeviceCodeLogin(); } }),
        el('button', { class: 'btn', style: { width: '100%', justifyContent: 'flex-start', marginTop: '8px' }, text: 'System browser — sign in outside, Neurax catches the result', onclick: () => { m.close(); openBrowserLogin(); } }),
        el('div', { class: 'hint', style: { marginTop: '12px', lineHeight: '1.6' },
          text: 'Azure setup (free): portal.azure.com → App registrations → New registration → "Personal Microsoft accounts only" → platform "Mobile and desktop applications" with http://localhost → enable "Allow public client flows". Paste the Application (client) ID when asked — NX Admin → Device & login IDs remembers it.' }),
      ),
    });
  }

  /* ---------- v4.3 device-code login (ADVANCED — needs your own Azure id) ----------
     The official Minecraft app id can NEVER do device codes: Microsoft
     answers AADSTS700016 ("application not found in the directory") because
     consumer MSA apps are not Entra-ID applications. Without a custom client
     id this modal shows the Azure setup form instead of starting a doomed
     flow; with one configured it runs the standard code-entry UI. */
  async function openDeviceCodeLogin() {
    if (!(state.settings.msClientId || '').trim()) {
      const customInput = el('input', { class: 'input', placeholder: '00000000-0000-0000-0000-000000000000', value: state.settings.msClientId || '', style: { marginTop: '8px' } });
      const m = openModal({
        title: 'Device-code sign-in (advanced)',
        sub: 'Microsoft refuses device codes for the official Minecraft app id (AADSTS700016 — consumer apps are not Entra-ID directory applications). Set your own free Azure client id to unlock this method.',
        body: el('div', {},
          el('div', { class: 'hint', style: { lineHeight: '1.6' }, text: 'Azure setup (free): portal.azure.com → App registrations → New registration → "Personal Microsoft accounts only" → platform "Mobile and desktop applications" with http://localhost → enable "Allow public client flows" → copy the Application (client) ID and paste it below.' }),
          el('label', { class: 'label', style: { marginTop: '12px' }, text: 'Azure client id' }),
          customInput,
          el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '14px' } },
            el('button', {
              class: 'btn primary', text: 'Save & continue',
              onclick: async () => {
                await saveSettings({ msClientId: customInput.value.trim() });
                m.close();
                if ((state.settings.msClientId || '').trim()) {
                  toast('Client id saved', 'Starting the device-code sign-in…');
                  openDeviceCodeLogin();
                }
              },
            }),
            el('button', { class: 'btn ghost', text: 'Use the sign-in window instead', onclick: () => { m.close(); openPopupLogin(); } }),
          ),
        ),
      });
      return;
    }
    const body = el('div', {});
    const m = openModal({
      title: 'Device-code sign-in',
      sub: 'A short code appears below: enter it once at microsoft.com/link in any browser, that is all.',
      body,
    });
    const status = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 0' } },
      el('span', { class: 'spinner' }), el('span', { class: 'hint', text: 'Contacting Microsoft…' }));
    body.append(status,
      el('button', {
        class: 'btn ghost', style: { marginTop: '10px' }, text: 'Cancel',
        onclick: async () => {
          try { await api.invoke('auth:msCancel', {}); } catch {}
          m.close();
        },
      }),
    );

    // advanced: optional custom Azure client id (saved, then the flow restarts)
    const adv = el('details', { style: { marginTop: '12px' } },
      el('summary', { class: 'hint', style: { cursor: 'pointer' }, text: 'Advanced: use a different Azure client id' }));
    const customInput = el('input', {
      class: 'input', placeholder: '00000000-0000-0000-0000-000000000000',
      value: state.settings.msClientId || '', style: { marginTop: '8px' },
    });
    adv.append(el('div', { style: { marginTop: '8px' } }, customInput,
      el('button', {
        class: 'btn small', style: { marginLeft: '8px' }, text: 'Use this id',
        onclick: async () => {
          await saveSettings({ msClientId: customInput.value.trim() });
          m.close();
          toast('Client id saved', 'Restarting the device-code sign-in…');
          openDeviceCodeLogin();
        },
      })));
    body.append(adv);

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
          el('span', { class: 'spinner' }), el('span', { class: 'hint', text: 'Waiting for approval… you can close this window anytime.' })),
      );
    });

    try {
      state.account = await api.invoke('auth:msStart', {});
      un();
      renderAccount();
      m.close();
      toast('Welcome, ' + state.account.name, 'Microsoft account connected. You can play online now.');
    } catch (err) {
      un();
      status.innerHTML = '';
      status.append(
        el('p', { style: { color: 'var(--danger)', lineHeight: '1.6', wordBreak: 'break-word' }, text: err.message }),
        el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '12px' } },
          el('button', { class: 'btn primary', text: 'Try again', onclick: () => { m.close(); openDeviceCodeLogin(); } }),
          el('button', { class: 'btn ghost', text: 'Use the sign-in window', onclick: () => { m.close(); openPopupLogin(); } }),
          el('button', { class: 'btn ghost', text: 'Browser flow (advanced)', onclick: () => { m.close(); openBrowserLogin(); } }),
        ),
      );
    }
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
  // v4.6 hardware-aware safe cap (integrated GPUs share system RAM with the game)
  let diag = null;
  try { diag = await api.invoke('diag:summary'); } catch { diag = null; }
  const safeCap = diag?.safeMemoryCapMB || (totalMB - 1024);
  const memAuto = state.settings.memoryAuto !== false;
  const slider = el('input', { type: 'range', class: 'slider', min: '1024', max: String(Math.max(2048, Math.min(totalMB - 1024, safeCap))), step: '256', value: String(Math.min(state.settings.memoryMB || 2048, safeCap)) });
  const memVal = el('span', { class: 'val', text: memAuto ? `Auto — up to ${fmtMem(safeCap)}` : fmtMem(state.settings.memoryMB) });
  const autoRow = el('div', { class: 'setting-row' },
    el('div', { class: 's-info' },
      el('b', { text: 'Automatic memory (recommended)' }),
      el('span', { text: `Neurax picks the best heap for THIS PC at every launch — ${fmtMem(safeCap)} here. Bigger PCs automatically get more RAM; integrated GPUs keep the driver's share free.` })),
    el('label', { class: 'switch' }, Object.assign(el('input', { type: 'checkbox' }), { checked: memAuto }), el('span', { class: 'track' }, el('span', { class: 'thumb' }))),
  );
  const autoBox = autoRow.querySelector('input');
  const applyMemMode = () => {
    slider.disabled = memAuto;
    slider.style.opacity = memAuto ? '.45' : '1';
    memVal.textContent = memAuto ? `Auto — up to ${fmtMem(safeCap)}` : fmtMem(Number(slider.value));
    autoBox.checked = memAuto;
  };
  autoBox.addEventListener('change', async () => {
    await saveSettings({ memoryAuto: autoBox.checked });
    applyMemMode();
  });
  slider.addEventListener('input', () => {
    if (memAuto) return;
    const v = Number(slider.value);
    slider.style.setProperty('--fill', ((v - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) * 100) + '%');
    memVal.textContent = fmtMem(v);
  });
  slider.addEventListener('change', () => { if (!memAuto) saveSettings({ memoryMB: Number(slider.value) }); });
  slider.style.setProperty('--fill', ((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) * 100) + '%');
  applyMemMode();

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

  /* ---------- Neurax Client (FPS boost stack) ---------- */
  const clientStatus = el('div', { class: 'hint', style: { lineHeight: '1.6' }, text: 'Checking…' });
  const renderClient = async () => {
    clientStatus.textContent = 'Checking…';
    try {
      const st = await api.invoke('client:status');
      const inj = (st.instances || []).filter((i) => i.injected);
      const cached = (st.cached || []).length;
      clientStatus.innerHTML = '';
      clientStatus.append(el('span', {
        text: `NX core: always injected • extra mods: ${state.settings.clientThirdPartyMods ? 'ON (opt-in)' : 'OFF (default)'} • scope: ${(st.instanceScope || []).join(', ') || '—'} • cached: ${cached} • injected instances: ${inj.map((i) => i.name).join(', ') || 'none yet'}`,
      }));
    } catch (e) { clientStatus.textContent = 'Status unavailable: ' + e.message; }
  };
  const fpsModeSel = el('select', { class: 'input', style: { maxWidth: '180px' } },
    el('option', { value: 'ultra', text: 'Ultra — everything' }),
    el('option', { value: 'balanced', text: 'Balanced — classics' }));
  fpsModeSel.value = state.settings.clientFpsMode === 'balanced' ? 'balanced' : 'ultra';
  fpsModeSel.addEventListener('change', async () => {
    await saveSettings({ clientFpsMode: fpsModeSel.value });
    toast('FPS mode saved', fpsModeSel.value === 'ultra' ? 'Full extras incl. parallel chunk loading (applies to the opt-in stack).' : 'Proven classics only (applies to the opt-in stack).');
    renderClient();
  });
  const clientCard = el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('label', { class: 'label', text: 'Neurax Client — the FPS boost engine' }),
    toggle('neuraxClient', 'Inject the NX mod', 'Every Fabric/Quilt launch gets the bundled NX core — the adaptive FPS engine (render distance, entities, particles, frame pacing) tuned for 1000+ FPS on any hardware, even integrated graphics with many entities and chunks. This is Neurax\u2019s own mod: it is always what gets injected automatically.'),
    toggle('clientThirdPartyMods', 'Extra optimization mods (Sodium & friends)', 'OFF by default — only Neurax\u2019s own mods inject automatically. Turn ON to also resolve Sodium, Lithium, Iris, C2ME, FerriteCore, ImmediatelyFast, EntityCulling, Krypton and Dynamic FPS from Modrinth. Even then: mods already in the instance are never duplicated, and VulkanMod automatically blocks the Sodium family (VulkanMod and Sodium are incompatible with each other).'),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' },
        el('b', { text: 'FPS mode (extras only)' }),
        el('span', { text: 'Only affects the opt-in third-party stack: Ultra = full extras + parallel chunk loading. Balanced = proven classics only. The NX core and the JVM flags always apply.' })),
      fpsModeSel,
    ),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' }, el('b', { text: 'Stack status' }), clientStatus),
      el('button', { class: 'btn small', text: 'Refresh', onclick: renderClient }),
    ),
    el('div', { class: 'hint', style: { marginTop: '10px' }, text: 'The NX core inside the game adapts render distance, entity distance, particles and more in real time to hold the target FPS. Mods resolve from Modrinth for your exact game version, are sha1-verified and cached — and never block a launch.' }),
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
      } else if (st.mode === 'offline') {
        // v4.4 — first-time / non-owner machines: a clean, friendly local-only state
        nxStatus.textContent = 'Working offline — NX Cloud is not configured on this device. Everything local (play, instances, servers, mods) works fully; chat, announcements and remote control switch on automatically once an owner connects their NX Cloud database.';
        nxStatus.style.color = 'var(--muted)';
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
        el('span', { text: 'Locked. Unlock it on the ANNOUNCEMENTS tab or right here in the Owner Console with the owner key — only the owner has it. The NEURAX CONTROL CENTER logs in with the built-in owner admin key.' })),
    ),
    el('div', { class: 'hint', style: { marginTop: '10px' }, text: 'Everything else is fully automatic: cloud sync, chat, announcements and the hidden device-bound UUID work in the background on your own Supabase database. Publish announcements and lock/unlock devices from the NEURAX CONTROL CENTER (nx-cloud → START-CONTROL-CENTER.bat).' }),
  );

  /* ---------- encrypted memory vault status (Storage & about) ---------- */
  const vaultStatus = el('span', { text: 'Checking…' });
  api.invoke('vault:status', {}).then((v) => {
    if (!v) { vaultStatus.textContent = 'Unavailable.'; return; }
    const when = v.updatedAt ? new Date(v.updatedAt).toLocaleString() : '—';
    vaultStatus.textContent = `${v.encrypted} · file locked READ-ONLY · remembers ${v.logins} login(s) · updated ${when}`;
  }).catch(() => { vaultStatus.textContent = 'Unavailable.'; });

  /* ================================================================= v1.0
     OWNER CONSOLE — see and edit EVERYTHING the launcher creates.
     THE FIX: the owner key is verified ONCE (owner:verifyKey) and creates the
     DEVICE GRANT — every later gated call is covered by that grant, so the
     old “success toast followed by Wrong owner passkey” can never happen
     again. The grant is persisted sealed in .neurax and auto-restores on the
     next launch, so the console unlocks itself for the owner.
     The key itself is NEVER displayed (removed by the owner's request). */
  const ownerState = { unlocked: false, files: [] };
  const ownerKeyRow = el('input', { class: 'input', type: 'password', placeholder: 'Owner key…', style: { maxWidth: '260px', display: 'inline-block', marginRight: '8px' } });
  const ownerBody = el('div', {});

  const openSealedFile = async (entry) => {
    try {
      const r = await api.invoke('owner:readFile', { file: entry.file });
      const ta = el('textarea', { class: 'input', rows: '16', style: { width: '100%', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre' } });
      ta.value = r.content || '';
      if (r.kind === 'binary') {
        openModal({ title: entry.name, sub: r.note || 'Binary file.', body: el('div', { class: 'hint', text: r.note || 'Binary encrypted vault file.' }), actions: (c) => [el('button', { class: 'btn ghost', text: 'Close', onclick: c })] });
        return;
      }
      const editable = !entry.name.startsWith('.') && entry.name !== 'device-identity.json';
      openModal({
        title: entry.name,
        sub: entry.sealed ? 'SEALED file shown DECRYPTED — saving re-encrypts it automatically.' : 'Plain JSON file.',
        body: el('div', {}, ta, editable ? null : el('div', { class: 'hint', style: { marginTop: '8px' }, text: 'This file is managed by the engine — view only.' })),
        actions: (close) => [
          el('button', { class: 'btn ghost', text: 'Close', onclick: close }),
          editable ? el('button', { class: 'btn primary', text: 'Save', onclick: async () => {
            try { await api.invoke('owner:writeFile', { file: entry.file, content: ta.value }); toast('Saved & re-sealed', entry.name); close(); } catch (e) { toast('Save failed', e.message, { type: 'error' }); }
          } }) : null,
        ].filter(Boolean),
      });
    } catch (e) { toast('Read failed', e.message, { type: 'error' }); }
  };

  const renderOwnerFiles = async () => {
    ownerBody.innerHTML = '';
    try {
      const r = await api.invoke('owner:listFiles', {});
      ownerState.files = r.files || [];
      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '8px' } });
      for (const f of ownerState.files) {
        const badge = f.sealed ? el('span', { style: { fontSize: '10px', padding: '2px 7px', borderRadius: '99px', background: '#10b98122', color: '#34d399', flexShrink: '0' }, text: 'ENCRYPTED' })
          : el('span', { style: { fontSize: '10px', padding: '2px 7px', borderRadius: '99px', background: '#64748b22', color: 'var(--muted)', flexShrink: '0' }, text: 'PLAIN' });
        list.append(el('button', {
          class: 'chip', style: { justifyContent: 'flex-start', width: '100%', background: 'transparent' },
          title: f.sealed ? 'Click to view DECRYPTED content and edit' : 'Click to view',
          onclick: () => openSealedFile(f),
        },
          badge,
          el('b', { text: (f.dir ? f.dir + '/' : '') + f.name }),
          el('span', { style: { opacity: '.55', fontSize: '11px', marginLeft: 'auto', flexShrink: '0' }, text: `${(f.bytes / 1024).toFixed(1)} KB` }),
        ));
      }
      ownerBody.append(list,
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
          el('button', { class: 'btn small', text: 'Unlock .neurax for deletion', onclick: async () => {
            try {
              const r2 = await api.invoke('owner:unlockData', { pass: ownerKeyRow.value });
              toast('Folder unlocked', `${r2.unlocked} file(s) released — you can now delete or move the data folder in Explorer.`);
            } catch (e) { toast('Refused', e.message, { type: 'warn' }); }
          } }),
          el('button', { class: 'btn small', text: 'Open data folder', onclick: () => api.invoke('app:openFolder', {}) }),
        ),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
          el('button', { class: 'btn small danger ghost', text: 'Factory reset (wipe ALL data)', onclick: () => {
            const inp = el('input', { class: 'input', placeholder: 'Type DELETE to confirm', style: { marginTop: '8px' } });
            openModal({
              title: 'Factory reset',
              sub: 'Moves the ENTIRE data folder (.neurax) and the hidden device anchor to the Recycle Bin, relaunches Neurax as a fresh install (new identity + new owner keys). Instances, servers, logins and settings are all erased.',
              body: inp,
              actions: (close) => [
                el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
                el('button', { class: 'btn danger', text: 'Wipe everything', onclick: async () => {
                  try {
                    const r2 = await api.invoke('owner:wipeAll', { pass: ownerKeyRow.value, confirm: inp.value });
                    close();
                    toast('Factory reset', r2.errors?.length ? r2.errors[0] : 'Data wiped — Neurax restarts fresh in a moment.');
                  } catch (e) { toast('Refused', e.message, { type: 'warn' }); }
                } }),
              ],
            });
          } }),
        ),
        el('div', { class: 'hint', style: { marginTop: '12px', lineHeight: '1.55' }, text: 'Why can\u2019t .neurax be deleted sometimes? Minecraft or the launcher holding it open, or an old build\u2019s write-protection. \u201cUnlock .neurax for deletion\u201d releases every protection this launcher ever applied — then delete the folder in Explorer, or use the factory reset above.' }),
      );
    } catch (e) { ownerBody.append(el('div', { class: 'hint', text: e.message })); }
  };

  const setOwnerUnlocked = (label) => {
    ownerState.unlocked = true;
    ownerKeyRow.disabled = true;
    ownerKeyRow.value = '';
    ownerUnlockBtn.disabled = true;
    ownerUnlockBtn.textContent = label;
  };

  const ownerUnlockBtn = el('button', { class: 'btn small primary', text: 'Unlock', onclick: async () => {
    try {
      // ONE verification — the device grant covers every later call
      const r = await api.invoke('owner:verifyKey', { pass: ownerKeyRow.value });
      setOwnerUnlocked('Unlocked');
      await renderOwnerFiles();
      toast('Owner Console unlocked', r.persisted
        ? 'The key was saved to .neurax — this device stays granted from now on.'
        : 'The key was verified. (The sealed grant file could not be written — access lasts for this session.)');
    } catch (e) { toast('Refused', e.message, { type: 'warn' }); }
  } });

  // auto-restore: a saved device grant (or a key already verified on the
  // ANNOUNCEMENTS tab) unlocks the console without typing anything
  api.invoke('owner:grantStatus', {}).then((st) => {
    if (st && st.granted) {
      setOwnerUnlocked(st.autoGranted ? 'Auto-granted' : 'Unlocked');
      renderOwnerFiles();
    }
  }).catch(() => {});

  const ownerCard = el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('label', { class: 'label', text: 'Owner Console — every file this launcher creates, seen and edited' }),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' },
        el('b', { text: 'What is in my data folder?' }),
        el('span', { text: 'Keys, tokens, settings and identity are stored as AES-256-GCM ciphertext that only this PC can open. Enter the owner key once — a correct key is SAVED to .neurax (sealed) and this device stays granted automatically on every future launch. The owner key itself is never displayed in this app.' })),
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexShrink: '0' } }, ownerKeyRow, ownerUnlockBtn),
    ),
    ownerBody,
  );

  /* ---------- diagnostics (v4.6 crash doctor) ---------- */
  const gpuText = diag && diag.gpus && diag.gpus.length
    ? diag.gpus.map((g) => `${g.name}${g.driver ? ` — driver ${g.driver}` : ''} (${g.type})`).join(' • ') + (diag.hasIntegratedGPU ? ' — integrated GPUs share system RAM, so the memory slider is capped automatically.' : '')
    : 'Graphics hardware could not be detected on this PC (generic memory limits apply).';
  const lc = diag?.lastCrash || null;
  const crashText = lc
    ? `${new Date(lc.ts).toLocaleString()} — ${lc.title}${lc.summary?.description ? ` (${lc.summary.description})` : ''}${typeof lc.uptimeSec === 'number' ? `, ${lc.uptimeSec}s after launch` : ''}`
    : 'No crashes recorded on this machine.';
  const diagCard = el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('label', { class: 'label', text: 'Diagnostics' }),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' }, el('b', { text: 'Graphics & memory' }),
        el('span', { text: gpuText })),
    ),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' }, el('b', { text: 'Last crash' }),
        el('span', { text: crashText })),
      (lc && lc.reportFile ? el('button', { class: 'btn small', text: 'Show file', onclick: () => api.invoke('app:showFile', { file: lc.reportFile }).catch(() => {}) }) : null),
    ),
    el('div', { class: 'setting-row' },
      el('div', { class: 's-info' }, el('b', { text: 'Safe mode packs' }),
        el('span', { text: diag?.safeModeArmed
          ? 'SAFE MODE IS ARMED — the next PLAY launches 100% vanilla (packs return after 10 clean minutes).'
          : 'If crashes keep repeating, Neurax launches once without resource packs. Restore them here any time.' })),
      el('button', { class: 'btn small', text: 'Restore packs', onclick: async () => {
        try {
          const r = await api.invoke('diag:restorePacks');
          const n = (r?.results || []).reduce((a, x) => a + (x.restored || 0), 0);
          toast(n ? `Restored ${n} pack${n === 1 ? '' : 's'}` : 'Nothing to restore', '');
        } catch (e) { toast('Restore failed', e.message, { type: 'warn' }); }
      } }),
    ),
  );

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
          el('span', { class: 'label', style: { margin: '0' }, text: 'Memory / total memory' }), memVal),
        autoRow,
        slider,
        el('div', { class: 'hint', style: { textAlign: 'right', marginTop: '4px' }, text: `Total: ${(totalMB / 1024).toFixed(0)} GB — safe cap ${fmtMem(safeCap)}${diag?.hasIntegratedGPU ? ' (integrated GPU shares system RAM)' : ''}` }),
      ),
      el('div', { class: 'card', style: { marginBottom: '16px' } },
        el('label', { class: 'label', text: 'Behaviour' }),
        toggle('closeLauncherOnLaunch', 'Close launcher on launch', 'Once Minecraft is confirmed running, Neurax quits (0% CPU/GPU/RAM) and reopens automatically when the game exits. If the game fails to start, the launcher STAYS open.'),
    toggle('smartInstall', 'Modrinth Smart Install', 'One-click installs a modpack straight into a matching instance. Turn off to always review the pack contents first.'),
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
      clientCard,
      diagCard,
      nxCard,
      ownerCard,
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
