import { createUserSupabase } from '../services/supabase.js';

export function createAuthMiddleware({ createClient = createUserSupabase } = {}) {
  return async function requireSupabaseUser(req, res, next) {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+([^\s]+)$/i.exec(header);
    if (!match) {
      return res.status(401).json({ error: 'Sign in to continue.' });
    }

    try {
      const accessToken = match[1];
      const supabase = createClient(accessToken);
      const { data, error } = await supabase.auth.getUser(accessToken);
      if (error || !data?.user?.id) {
        return res.status(401).json({ error: 'Your session is invalid or expired. Sign in again.' });
      }

      req.supabase = supabase;
      req.user = { id: data.user.id, email: data.user.email || null };
      return next();
    } catch {
      return res.status(401).json({ error: 'Your session could not be verified. Sign in again.' });
    }
  };
}
