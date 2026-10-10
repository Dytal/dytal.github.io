# Sky Hopper — Flight Club feature patch

This patch contains the changed/new files for the animated in-game Bazaar, cosmetic rendering, Arcade-only coin rewards, achievement UI and world ambience.

## Apply

1. Back up your existing folder.
2. Extract this patch into the project root, allowing included files to overwrite.
3. Preserve your existing `styles.css` and `supabase-config.js`. The patch includes a matching `favicon.svg` if you want the included Flight Club icon.
4. If using an existing Sky Hopper database from the previous master schema, run **only** `supabase/store_cosmetics_coins_patch.sql`. For a new database, run the full root `supabase.sql` instead. Do not run both paths.
5. Commit and push to GitHub; Cloudflare Pages should deploy from `main`.

## What's included

- Achievement notifications in the sidebar rather than over the canvas.
- Animated store dialog with Birds, Auras, Trails & Wings, and Upgrades tabs.
- 72 individually named cosmetic items with descriptions, rarity, prices, palettes, symbols and texture motifs.
- 120 ability relics with rarity, power, description, aura colour and procedural texture identity.
- Whole-coin Arcade economy: 1 coin per cumulative 100 Arcade points; no coins for Classic.
- 1,000 achievement targets, including long-haul and deliberately extreme upper milestones.
- Gradually moving sun/moon, day phases and seasonal colour transitions.
- Supabase ownership, loadout and purchase functions plus the coin-rule migration.

## Notes

Guest progression stays in memory and will disappear on refresh. Signed-in progress and purchased/equipped items are stored in Supabase. Auth tokens are not persisted to browser storage. The live database has not been run by this patch; perform the SQL installation and test the listed workflows in `SUPABASE_SETUP.md`.
