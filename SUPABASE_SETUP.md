# Supabase setup for Sky Hopper — Flight Club

This guide enables cloud accounts, player profiles, Arcade coin rewards, long-term achievements, collectible inventory, upgrades, store cosmetics and equipped bird styles.

## 1. Choose the right SQL file

**Fresh database:** create a Supabase project, open **SQL Editor → New query**, paste the complete `supabase.sql` file from the project root (or its duplicate `supabase/schema.sql`), and run it once.

**Existing Sky Hopper database:** if you already installed the previous Sky Hopper master schema, back up the project and run `supabase/store_cosmetics_coins_patch.sql`. This migration also adds the secure custom-name RPC and does not delete existing player rows. If you already ran this store/cosmetics migration before the custom-name update was added, run only `supabase/set_pilot_username_patch.sql`. Do not run the full master schema on a live database as a substitute for the migration.

After running, review the entire SQL Editor result. The migration checks for 1,000 achievements, 120 abilities and 72 store cosmetics, verifies that prices are between 0 and 100 coins, and verifies that the four default cosmetics cost zero. If the query reports an error, stop and resolve it before publishing the frontend update.

## 2. Configure the website key

Open `supabase-config.js` and fill in your project URL and public publishable key (or legacy `anon` key):

```js
window.SKYHOPPER_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_ID.supabase.co",
  supabaseAnonKey: "YOUR_PUBLIC_PUBLISHABLE_KEY"
};
```

This file is visible to every visitor. Only use the public browser key. Never put the `service_role` key or any secret key in HTML, JavaScript, GitHub, or Cloudflare Pages environment variables exposed to the client.

## 3. Set up sign-up redirects

1. In Supabase, open **Authentication → URL Configuration**.
2. Set **Site URL** to the actual deployed address, for example `https://your-project.pages.dev`.
3. Add the live URL and any URLs you intend to use for email-confirmation redirects to the allowed redirect list.
4. Decide whether email confirmation stays enabled and test the complete flow with a new account.

The app uses `persistSession: false` so auth tokens remain in memory rather than browser storage. Players may have to sign in again after refreshing the page; the cloud profile and progress remain in Supabase.

## 4. Deploy to Cloudflare Pages

Use Git integration from Cloudflare Pages:

- Framework preset: **None / Other**
- Production branch: `main`
- Build command: empty (or `exit 0` if the dashboard requires a command)
- Build output directory: `.`
- Root directory: blank / repository root

Keep `index.html`, `app.js`, `styles.css`, `expansion.css` and `supabase-config.js` together at the deploy root. Commit the patch and wait for the deployment to report success, then hard-refresh the site.

## 5. Verify the core workflows

1. Create a test account, verify email if confirmation is enabled, and sign in.
2. Complete one short **Classic** run. Confirm the flight is saved and the wallet receives **zero coins**.
3. Complete Arcade runs with a combined total that crosses 100 Arcade points. Confirm the wallet gets one coin each time a cumulative 100-point threshold is crossed. For example, 75 Arcade points followed by 30 more earns one coin on the second run.
4. Collect a relic in Arcade and confirm it appears in `player_inventory`.
5. Buy a cosmetic or upgrade. Confirm the purchase deducts coins and adds the owned item/upgrade in the database.
6. Equip a purchased cosmetic and check `player_loadout`. Reload the page, sign in again, and verify the equipped style and wallet reload from Supabase.
7. Unlock an achievement and confirm a row appears in `user_achievements`. Achievement notices should appear in the side rail, not over the canvas.
8. Change the pilot name while signed in. Confirm the new unique name appears in the profile and global leaderboard. If the custom-name RPC is missing, run the standalone patch described above.
9. Play Arcade repeatedly and check that relics appear with visible room around gates rather than overlapping a pipe.

## 6. Where data lives

- `auth.users` / Supabase Auth: authentication credentials and account identity.
- `profiles`: public pilot name, best score, XP, level and update timestamp.
- `player_stats`: flights, lifetime score, Arcade score, coins, collected item counts, rare-item counts, purchase counts.
- `user_achievements`: achieved codes and timestamps.
- `player_inventory`: owned relic quantities.
- `player_upgrades`: purchased permanent upgrade levels.
- `flight_runs`: a signed-in player's run history.
- `store_catalog`: read-only public store inventory, artwork metadata and coin prices.
- `player_cosmetics`: each player's purchased/claimed cosmetics.
- `player_loadout`: currently equipped bird, aura, trail and wing styles.

Guest progression is held in memory only and is discarded on refresh/close. A guest's chosen display-name preference alone is stored under `skyhopper_pilot_name` in local storage; it is not a progress save and is not shared with the global leaderboard. The current flight's physics necessarily runs in memory while playing.

## Economy logic

The database grants coins only for Arcade points, using the cumulative-Arcade-score threshold formula:

```sql
floor(new_arcade_score / 100) - floor(old_arcade_score / 100)
```

This corresponds to 0.01 coin per Arcade point, credited as whole coins at each 100-point milestone. Classic runs add zero to the Arcade score and pay zero coins. The client displays the same calculation, but the database RPC is authoritative for signed-in balances. Store prices are at most 100 coins; there is no real-money checkout.

## Troubleshooting

- **“Supabase is not configured”:** check URL/key spelling and wait for the Cloudflare deployment.
- **`Failed to fetch`:** check network access and whether the browser can load `@supabase/supabase-js` from jsDelivr.
- **Missing column/table/function:** verify you ran the correct full-install or migration script in the same Supabase project connected in `supabase-config.js`.
- **Classic coins changed:** refresh cloud state and inspect the `submit_run` function definition; the new migration replaces it with Arcade-only reward logic.
- **Store is visible but purchases fail:** check `store_catalog`, `player_cosmetics`, `player_loadout` and the `purchase_store_item` / `equip_store_item` functions. Do not fix RLS issues by granting unrestricted client writes.
- **Email links redirect incorrectly:** add the deployed address to Supabase Auth URL Configuration.
- **Sign-in required after refresh:** this is expected with `persistSession: false`. Cloud progression stays in the database.

## Important limitations and privacy

The browser score is validated, but not fully cheat-proof: a determined user can fabricate plausible runs. A server-authoritative game/session system is needed for competitive-grade anti-cheat. The included `privacy.html` is a project notice, not legal advice. Publish a monitored private contact method, verify account/data deletion, and configure the required Google-certified Consent Management Platform in AdSense Privacy & Messaging before serving personalised ads to UK/EEA/Swiss visitors. Review the notice after any tracking, ad or database changes. Google requires AdSense applicants to be 18+; applicants under 18 need a parent/guardian to apply using their own Google Account.
