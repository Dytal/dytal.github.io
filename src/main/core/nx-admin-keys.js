'use strict';
// nx-admin-keys.js — FIXED NX admin credentials, baked in at the owner's request.
//
//   ADMIN_KEY       → logs into the NEURAX CONTROL CENTER (also accepted as the
//                     X-Admin-Key header for scripts). NOT user-editable in the UI.
//   UNLOCK_PASSKEY  → unlocks the NX Admin panel inside the launcher
//                     (ANNOUNCEMENTS tab → "NX Admin"). NOT user-editable in the UI.
//
// Escape hatch: the Control Center honors a NEURAX_ADMIN_KEY environment
// variable override (handy for tests / rotating the key without a patch).
module.exports = {
  ADMIN_KEY: 'sINm6w7h8PfCelSnlirOhgTPq2wSd03X',
  UNLOCK_PASSKEY: 'Auiwadhagwid156!78hduZaAgd768@ahwiZ',
};
