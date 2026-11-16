import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// Every request gets a client carrying that user's JWT. Postgres RLS therefore
// applies to reads and writes; the server never uses a service-role bypass key.
export function createUserSupabase(accessToken) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to .env.');
  }
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('A Supabase access token is required.');
  }

  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
