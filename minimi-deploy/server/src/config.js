import dotenv from 'dotenv';

// Load the single root .env file even when npm runs this workspace from /server.
dotenv.config({ path: new URL('../../.env', import.meta.url) });

export const config = {
  port: Number(process.env.PORT || 3001),
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean),
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.5',
  tavilyApiKey: process.env.TAVILY_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

export function missingServerConfig() {
  return [
    ['OPENAI_API_KEY', config.openaiApiKey],
    ['TAVILY_API_KEY', config.tavilyApiKey],
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.supabaseServiceRoleKey],
  ].filter(([, value]) => !value).map(([name]) => name);
}
