# Neurax Launcher — v3.1.5
## Encrypted memory vault (remembered logins + passkeys, read-only), announcements auto-refresh, and the lock-message typing fix

**Version:** 3.1.5 · **PATCH — extract over your project root (the folder with package.json). No npm install, no SQL changes.**

---

## 0 · The four things you asked for

**1. "Add memory in the Neurax Control Center to remember logins and passkeys."**
The console now keeps an **encrypted memory vault** (`cc-vault.bin`). Every
browser login is remembered — after you close and restart the console, your
browser tab is **still logged in**, no key re-typing. Every login is also
remembered in a history (timestamp + IP), and the fixed admin key +
unlock passkey are stored inside the vault itself.

**2. "And same for my launcher."**
The launcher gets the same kind of vault (`vault.bin`). Every login —
offline names and Microsoft accounts, including silent session restores — is
remembered. The **Offline name** window now shows **"Remembered logins"
chips**: one click re-fills a name you used before. Settings → Storage & about
shows a new **"Encrypted memory vault"** status row. The owner passkey that
unlocks the NX Admin panel is verified **through the vault**, and every
successful unlock is remembered.

**3. "Make those files not readable and editable — read only and encrypted."**
Both vault files are:
- **ENCRYPTED** — AES-256-GCM (authenticated encryption). The key is derived
  from a random per-machine key file (`.vk`, written once, locked too) mixed
  with a pepper baked into the build. The vault file alone is unreadable
  garbage on any other PC; `.vk` alone is meaningless random bytes. Opening
  `vault.bin` in an editor shows only ciphertext — no plaintext logins or keys.
- **READ-ONLY** — the file is locked `0400` (Windows: read-only attribute)
  after every write. Editors refuse to save changes back.
- **TAMPER-HEALING** — if someone force-edits the file anyway, the built-in
  cryptographic tag rejects it: the broken file is quarantined as
  `*.corrupt-<timestamp>` and a fresh vault is built automatically. You are
  never locked out, and silent edits are impossible.

**4. "In the Control Center, when I write a lock message it resets every 5
seconds — keep the fast refresh, but stop it wiping my typing."**
Found it and fixed it properly. The 5-second refresh re-renders the device
list, and that used to destroy the lock-reason box you were typing in. Now the
page **snapshots every field (value + caret position + keyboard focus) before
each refresh and restores it right after** — the 5s live data stays exactly as
fast as you want it, and your typing, cursor and focus survive every single
tick. (Also preserved: the minutes field, checkbox states, and whether an
instances list is folded open.)

**Bonus (also as you asked): "1-minute auto refresher in the ANNOUNCEMENTS
tab in my launcher."** The launcher's ANNOUNCEMENTS tab now pulls fresh
announcements **every 60 seconds** automatically. It only re-renders when the
content actually changed (no flicker or scroll jump while you read), and the
red NEW badge stays current even when you are on other tabs.

## 1 · A hidden bug found and fixed on the way: the console was reading the WRONG settings file

While wiring the vault in, a real path bug surfaced: the Control Center
resolved its data folder as `%APPDATA%` — but the launcher's settings live in
`%APPDATA%\.neurax\settings.json`. The console never actually read (or shared)
the launcher's settings on Windows/Linux/macOS defaults; it only worked
because your database URL happens to be baked in as the fallback. Now the
console resolves the **exact same `.neurax` root through the launcher's own
`paths.js`**, so:

- the console finally **shares the cached pooler host** with the launcher
  (faster console connect, no duplicate sweeps),
- the vault + settings locations can never drift apart again,
- `nxSupabasePooler` discovered by either side is now truly shared.

## 2 · What the vault remembers (quick reference)

| File | Remembered contents |
|------|---------------------|
| `%APPDATA%\.neurax\cc-vault.bin` (console) | Browser sessions (stay logged in across restarts, 7-day cookie / 30-day prune), login history (timestamp + IP, last 20), fixed admin key, fixed unlock passkey |
| `%APPDATA%\.neurax\vault.bin` (launcher) | Remembered logins (last 12, offline + Microsoft, with use counts), active account mirror, last admin unlock time, fixed admin key, fixed unlock passkey |
| `%APPDATA%\.neurax\.vk` | 32 random bytes — the machine-bound key file (created once, locked read-only; both vaults share it) |

Nothing user-configurable was added — the vault just works in the background.
Deleting a vault file is always safe: it rebuilds from defaults on the next
start (keys stay baked in, you can never be locked out).

## 3 · Everything else unchanged

v3.1.4's fixed admin key + separate launcher passkey (both baked,
`sINm…` for the console, `Auiw…` for the launcher panel), the Windows
`pathToFileURL` fix, the v3.1.3 port-fallback console, v3.1.1's connection
engine, chat, invites, skin heads, offline grace — all exactly as before.
**No database changes.**

## 4 · Verified by real tests (this release)

- **NEW `probe-vault.js` — 22/22 PASS**: create-on-first-use, encryption at
  rest (no plaintext secrets in raw bytes), read-only enforcement, save→load
  roundtrip, login upsert + 12-cap, CC session remember/forget + history,
  **tamper healing** (force-edited file → quarantined + rebuilt), foreign
  machine key rejection, garbage-file replacement, `.vk` locked read-only.
- **`probe-control-center.js` — now 68/68 PASS**, including NEW live checks:
  vault file created + read-only + encrypted, **the same browser session
  survives a full console restart** (login remembered), the fixed key works
  with no environment override (vault/baked fallback chain), login history +
  both passkeys present in the decrypted vault, and the **default-root fix**
  proven live (console reads `$XDG_CONFIG_HOME/.neurax/settings.json` and
  connects), plus all previous auth/lock/announcement/EADDRINUSE coverage.
- **NEW `probe-boot.js` — 11/11 PASS** on a real Electron boot: cloud link
  established, offline login remembered into the vault, vault read-only +
  encrypted on disk, vault-backed passkey check, clean boot log.
- Regressions: `probe-nx-supabase` **39/39**, `probe-nx-supabase-ui` **24/24**,
  `probe-nx-cloud` **26/26**, `probe-nx-integration` **21/21**, core tests
  green, syntax + imports clean.

## Files in this patch

- `src/main/core/nx-vault.js` — **NEW: the shared encrypted memory vault**
- `nx-cloud/control-center.js` — vault memory (sessions + login history + passkeys), **.neurax root path fix**, version 3.1.5
- `nx-cloud/control-center.html` — **typing survives the 5s refresh**, remembered-login hint
- `src/main/core/auth.js` — every login remembered into the vault
- `src/main/ipc.js` — passkey check via vault, `vault:status` + `vault:remembered` endpoints, logout keeps login history
- `src/renderer/js/pages/settings.js` — remembered-login chips in Offline name, "Encrypted memory vault" status row
- `src/renderer/js/nx.js` — 1-minute ANNOUNCEMENTS auto-refresh (change-detected, scroll-safe)
- `src/renderer/js/mock-bridge.js` — demo-mode vault endpoints
- `scripts/probe-vault.js` — **NEW** vault test battery · `scripts/probe-boot.js` — **NEW** real-boot test
- `scripts/probe-control-center.js` — extended to 68 checks
- `package.json` (3.1.5), `PATCH-NOTES.md`
- Plus the full v3.1.0–v3.1.4 superset (safe over v3.0.0 too): `supabase/nx-supabase-setup.sql`,
  `src/main/core/nx-admin-keys.js`, `src/main/core/nx-supabase.js`, `src/main/core/skin-heads.js`,
  `src/main/core/nx-cloud.js`, `src/main/core/settings.js`, `src/main/vendor/postgres/*`,
  `src/renderer/styles/nx.css`, `nx-cloud/server.js`, `nx-cloud/admin.html`,
  `nx-cloud/START-NX-CLOUD.bat`, `nx-cloud/START-CONTROL-CENTER.bat`, `nx-cloud/README.md`,
  `scripts/probe-nx-supabase.js`, `scripts/probe-nx-supabase-ui.js`, `scripts/probe-nx-cloud.js`
