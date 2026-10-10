/*
  Sky Hopper backend configuration.
  Copy your Supabase Project URL and publishable key from Project Settings > API Keys.
  This file is safe to expose in a browser ONLY when the database has the supplied RLS policies.
  Never put a service_role/secret key in this file.
*/
window.SKYHOPPER_CONFIG = {
  supabaseUrl: "https://invoqcismjgwbropdqvs.supabase.co",       // e.g. https://abcdefgh.supabase.co
  supabaseAnonKey: "sb_publishable_WWXjjpZbAR0grHmUqFC8ng_TVqdYa6J"    // preferred: sb_publishable_... (legacy anon keys also work)
};
