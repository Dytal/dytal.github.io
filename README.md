# Sky Hopper — Flight Club

A free browser arcade game built with HTML, CSS, Canvas and JavaScript. It deploys to Cloudflare Pages as a static site; no build step or game server is required. Supabase supplies accounts and durable player data.

## Current project

Sky Hopper is an original browser arcade game maintained by **Anish Sandeep Bhargav (Dytalmc)**. The public site includes a playable game plus a first-party guide, FAQ, About page, Contact page, privacy notice and licence page. The game works without a build step.

## Features

- **Achievement notices never cover the play canvas.** New milestones appear in a dismissible side-rail notice panel.
- **Classic mode:** one collision ends the run; gates get faster gradually while the classic gap remains familiar. Classic awards **no coins**.
- **Arcade mode:** starts at Normal and automatically ramps through Swift, Hard, Expert and Chaos. Gate pace, spacing, width and gap placement become more unpredictable as the score climbs. Health, abilities and 120 collectible relics are available here.
- **Arcade coin economy:** each Arcade score point contributes 0.01 coin. The wallet uses whole coins, so it credits one coin each time cumulative Arcade points cross a 100-point threshold. Coins never come from Classic runs, relic pickups, XP or best-score bonuses.
- **120 ability relics:** eight effect families across six rarity tiers, each with a name, description, aura colour, texture motif, power rating and probability shown in the relic codex. Abilities can affect shields, time, healing, magnet pickup reach, lift, or bonus points.
- **72 cosmetics:** 18 bird looks, 18 auras, 18 trails and 18 wing looks. Each has its own palette, motif, rarity, description and up-to-100-coin price. Default looks are free. The animated popup Bazaar also contains the permanent upgrade workshop.
- **Living sky:** the sun and moon travel across the backdrop; dawn, morning, noon, evening and night blend gradually. Spring, summer, autumn and winter transition through blended palettes, with occasional night-sky easter eggs.
- **1,000 achievements:** six achievement families range from first flights to long-haul milestones. The top tiers are deliberately extreme; the final flight, collection and rare-find achievements may be effectively out of reach for normal play. Store-purchase achievements use the cloud-side purchase count.
- **Supabase progression:** signed-in profiles, scores, coins, XP, flights, achievements, relic inventory, upgrades, purchased cosmetics and equipped loadout are cloud-saved. Store purchases and coin rewards use database RPCs; guests get temporary in-memory progress only.
- **No real-money purchases.** The in-game store only spends gameplay-earned coins.

## Apply the patch

1. Back up the current repository.
2. Extract the project ZIP and copy its contents into the repository root, preserving `supabase-config.js` and its public key unless you intend to change the backend.
3. Keep `index.html`, `app.js`, `styles.css`, `expansion.css`, `content.css` and `supabase-config.js` at the repository root.
4. Follow `SUPABASE_SETUP.md`. Existing databases need the add-on SQL for the new username RPC.
5. Test the game and all pages locally, then commit and deploy. Recheck the live site on desktop and mobile.

## Supabase SQL — choose only one installation path

- **Brand-new database:** run the full root `supabase.sql` (or identical `supabase/schema.sql`) once in Supabase SQL Editor.
- **Existing Sky Hopper database with the previous master schema:** run only `supabase/store_cosmetics_coins_patch.sql`. It adds cosmetic catalogues and ownership/loadout tables and updates Arcade coin rewards and long-term achievement thresholds without dropping player records.
- If the updated store migration was already applied before the custom-name RPC was added, run only `supabase/set_pilot_username_patch.sql`. Do not run the full master script on a live existing database as a substitute for the migration. Back up first, use the applicable migration once, and check every SQL Editor result for errors.

## Files

- `index.html` — game, side-rail achievement notice and animated store dialog.
- `app.js` — game physics, difficulty ramp, cosmetics rendering, world clock, awards, coin reward display and Supabase calls.
- `expansion.css` — store popup, item cards, textures, animations and responsive layout.
- `styles.css` — existing base styles; preserved by this patch.
- `supabase-config.js` — set only your Supabase project URL and public publishable/anon key.
- `supabase.sql` — consolidated single-file fresh-install database script.
- `supabase/store_cosmetics_coins_patch.sql` — incremental migration for an existing installation.
- `SUPABASE_SETUP.md` — configuration and test guide.
- `ADSENSE_REVIEW_CHECKLIST.md` — deployment, privacy/consent and AdSense re-review checklist.
- `guide.html`, `faq.html` — original gameplay walkthrough and player troubleshooting.
- `contact.html`, `license.html`, `COPYRIGHT.md` — reporting route, licence overview and copyright notice.
- `content.css` — shared accessible styling for editorial pages.
- `privacy.html`, `about.html` — project and privacy descriptions.
- `supabase/set_pilot_username_patch.sql` — secure RPC migration for custom cloud pilot names.

## Cloud-only persistence and security

Guest progress remains in RAM and vanishes on reload. The app deliberately does not persist player progression or Supabase auth sessions to `localStorage`/`sessionStorage`; signed-in players need to sign in again after a refresh, but their account data stays in Supabase. Only the project URL and public key belong in frontend config. Never expose Supabase service-role or secret keys.

Database RPCs protect coins and purchase operations from direct client writes. The game is still a client-side game, so the score endpoint cannot guarantee cheat-proof competitive results. High-stakes/competitive anti-cheat would need server-authoritative run verification.

## Controls

- Flap: `Space`, `Arrow Up`, `W`, click or tap the play area.
- Pause/resume: `P` or `Escape` when no dialog is open.
- Arcade abilities: `Q` (shield), `E` (slow skies), `R` (heart bloom).

## Economy details

Let `arcade_total` be the player's cumulative Arcade points before a run and `run_score` the score for this Arcade run:

`coins_earned = floor((arcade_total + run_score) / 100) - floor(arcade_total / 100)`

Classic adds zero to `arcade_total` and always awards zero coins. This is equivalent to accruing 0.01 coin per Arcade point, with a whole-number coin wallet. Prices are capped at 100 coins per store cosmetic and upgrade level.
