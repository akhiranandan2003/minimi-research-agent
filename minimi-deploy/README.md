# Minimi Research Agent

A conversational research assistant with one model-visible external tool: **Tavily web search**. The React client, Node API, Supabase conversation memory, and tests are in this folder.

## Requirements

- Node.js 22 or newer
- OpenAI API key
- Tavily API key
- Supabase project

## Run locally

1. From this folder, copy .env.example to .env and fill in OPENAI_API_KEY, TAVILY_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.
2. In Supabase Dashboard → SQL Editor, run supabase/schema.sql. Ensure the public schema is exposed to the Data API. RLS is enabled and no anon/authenticated policies are created; the Node API uses the server-side key.
3. From this folder run npm install and npm run dev.
4. Open http://localhost:5173. The API runs on http://localhost:3001.

## Tests and build

Run npm test and npm run build from this folder.

## Memory and research behavior

- Recent conversation messages are loaded from the database for each turn.
- Historical questions also trigger full-text search over older messages in the same conversation. Only actual stored user/assistant rows are supplied as memory; if the requested detail is not present, Minimi must say so.
- History-only questions do not invoke web search. Change-over-time questions use prior context and dated web evidence, compare like-for-like measures, and state uncertainty when dates or scope do not match.
- Search citations are numbered, de-duplicated, restricted to HTTP(S) URLs, and checked against the source list before saving the answer.
- Retrieved web content is untrusted evidence. It cannot change the agent's instructions or authorize other tools.

## Deploy (GitHub + Render + Vercel)

The repository currently contains this project in minimi-deploy/.

1. **Render API:** create a Blueprint from minimi-deploy/render.yaml. The service root is minimi-deploy/server. Add OPENAI_API_KEY, TAVILY_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and CLIENT_ORIGIN in Render. Set CLIENT_ORIGIN to the exact Vercel website origin after deploying the frontend.
2. **Vercel frontend:** import the repository and set Root Directory to minimi-deploy/client, framework to Vite, build command to npm run build, and output directory to dist. Set VITE_API_BASE_URL to the Render API URL (no trailing slash).
3. Open https://YOUR-API-URL/api/health; after the four server secrets are set it should report status ok. Send a chat message, refresh, and verify that history is restored.

## Security limitations

- Never commit .env. Only VITE_API_BASE_URL belongs in Vercel; never expose the OpenAI, Tavily, or Supabase server-side key in a VITE_ variable.
- The random conversation UUID is a demo access handle, not user authentication. Add Supabase Auth and per-user ownership policies before storing sensitive conversations or using this with multiple users.
- The model has exactly one external tool: web_search. OpenAI and Supabase are the model/database services, not additional model tools.