# Minimi Research Agent

A conversational research assistant with one model-visible external tool: **Tavily web search**. The React client, Node API, Supabase Auth, PostgreSQL conversation memory, and tests are in this folder.

## Requirements

- Node.js 22.12 or newer
- OpenAI API key
- Tavily API key
- Supabase project with Email authentication enabled

## Run locally

1. From this folder, copy `.env.example` to `.env`.
2. Fill in `OPENAI_API_KEY`, `TAVILY_API_KEY`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the same Supabase project values, and keep `VITE_API_BASE_URL=http://localhost:3001`.
3. In Supabase Dashboard → Authentication → Providers, enable Email. Choose whether sign-up requires email confirmation.
4. In Supabase Dashboard → SQL Editor, run `supabase/schema.sql`. This creates owner-scoped RLS policies. If upgrading the earlier anonymous demo schema, old rows with no `user_id` remain inaccessible because their owner cannot be inferred; back them up and clean them up manually if desired.
5. From this folder run `npm install` and `npm run dev`.
6. Open http://localhost:5173, create an account or sign in, then start chatting.

## Tests and build

Run `npm test` and `npm run build` from this folder. GitHub Actions runs both checks on pushes and pull requests targeting `main`.

## Memory and research behavior

- Recent messages and older topic-matching messages are loaded from PostgreSQL for the signed-in user and the requested conversation only.
- Historical-only questions do not invoke web search. If the stored messages do not contain the requested detail, Minimi must say so.
- Change-over-time questions use relevant prior context and dated web evidence, compare like-for-like measures, and state uncertainty when evidence is incomplete.
- Search citations are numbered, de-duplicated, restricted to HTTP(S) URLs, and validated before the answer is saved.
- Retrieved web content is untrusted evidence; it cannot change instructions or authorize another tool.

## Deploy (GitHub + Render + Vercel)

1. **Render API:** create a Blueprint from `render.yaml`. Set `OPENAI_API_KEY`, `TAVILY_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `CLIENT_ORIGIN` in Render. Use the exact Vercel website origin for `CLIENT_ORIGIN`.
2. **Vercel frontend:** import the repository and set Root Directory to `minimi-deploy/client`, framework to Vite, build command to `npm run build`, and output directory to `dist`. Set `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY`.
3. In Supabase Auth URL Configuration, add the Vercel URL to the allowed Site URL/redirect URLs. Keep Email authentication enabled.
4. Check `https://YOUR-API-URL/api/health`, create a user, send a message, refresh, and verify history is restored.

## Security

- The browser receives only the Supabase anon/publishable key. Never expose a service-role/secret key in a `VITE_` variable.
- The API verifies every Supabase access token with Auth and uses a Supabase client carrying that user's JWT. Postgres RLS and explicit `user_id` + `conversation_id` filters protect message reads and writes.
- Chat requests are limited to 20 per signed-in user per minute per API process. For multi-instance production, replace the in-memory limiter with a shared store such as Redis.
- The model has exactly one external tool: `web_search`. OpenAI and Supabase are the model/database services, not additional model tools.
