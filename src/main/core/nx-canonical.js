'use strict';
// nx-canonical.js — THE OWNER'S FIXED CREDENTIALS (v4.5).
//
// The owner (Anish Sandeep Bhargav — Dytalmc) chose ONE key for everything
// and ONE NX Cloud database for every installation of Neurax:
//
//   OWNER_KEY            THE admin key AND unlock passkey. It unlocks the NX
//                        Admin panel, the Owner Console and the NEURAX
//                        CONTROL CENTER on EVERY device that runs this
//                        launcher — always, on every install, even after
//                        the .neurax folder was deleted and re-created.
//                        Stored sealed (AES-256-GCM, machine-bound) in
//                        .neurax/keys.vault on first run; re-seeded by the
//                        key resolver whenever an installation is found
//                        without it (see nx-admin-keys.js SEED_VERSION).
//
//   OWNER_SUPABASE_URL   The owner's NX Cloud database (Supabase Postgres).
//                        EVERY installation connects to it automatically —
//                        the launcher does NOT need the NX Cloud console or
//                        any local relay to have run first. Chat, DMs,
//                        friends, voice, announcements, remote lock and the
//                        blocklist work out of the box; the launcher talks
//                        straight to this database every 5 seconds, and the
//                        NEURAX CONTROL CENTER (nx-cloud/control-center.js)
//                        sends/receives the same tables so the owner and the
//                        launchers always see the same information.
//
// *** CHANGE THE DATABASE PASSWORD HERE ***
// If you reset the database password in the Supabase dashboard
// (Project Settings → Database → Reset database password), paste the new
// connection string over OWNER_SUPABASE_URL below and rebuild. This file is
// the ONLY place a connection string lives — no other file needs editing.
//
// Everything downstream reads from this module:
//   - nx-admin-keys.js   → seeds/validates the sealed key vault
//   - settings.js        → default nxSupabaseUrl (sealed into settings.vault)
//   - control-center.js  → default database URL + admin login
//   - scripts/rotate-nx-keys.js → writes the fixed key into key files

const OWNER_KEY = 'AAhdswedgjihsedfyg2346283jsd!';
const OWNER_SUPABASE_URL =
  'postgresql://postgres:AnishWorrior001@db.invoqcismjgwbropdqvs.supabase.co:5432/postgres';

module.exports = { OWNER_KEY, OWNER_SUPABASE_URL };
