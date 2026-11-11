# Minimi Research Agent

A conversational research assistant with exactly one external tool: Tavily web search.

## Requirements

- Node.js 22 or newer
- OpenAI API key
- Tavily API key
- Supabase project

## Setup

1. Copy `.env.example` to `.env` in the project root.
2. Fill in `OPENAI_API_KEY`, `TAVILY_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
3. In Supabase Dashboard → SQL Editor, run `supabase/schema.sql`.
4. In Supabase Dashboard → API Settings, ensure the `public` schema is exposed to the Data API (new tables are not exposed automatically on current projects). RLS is enabled and no anon/authenticated policies are added; the Node API uses the server-only key.
5. From the project root run:

   ```bash
   npm install
   npm run dev
   ```

6. Open the Vite URL printed in the terminal (normally `http://localhost:5173`). The API runs on `http://localhost:3001`.

## Tests and build

```bash
npm test
npm run build
```

## Security notes

- Keep `.env` private. Never paste the Supabase server-side key into frontend code or any `VITE_` variable.
- The random conversation UUID is a demo access handle, not account authentication. Add Supabase Auth and ownership policies before production use.
- Web snippets are untrusted input. The system prompt explicitly prevents retrieved page text from overriding application instructions.
- The agent is allowed one external tool only: `web_search` (Tavily).

## Current scope

This is the first working slice: chat UI, API, bounded tool-calling loop, durable message writes/reads, source links, and focused unit tests. Conversation history currently loads the latest 40 messages; semantic retrieval, streaming, authentication, and deployment are planned follow-ups.


## Deploy online (GitHub + Render + Vercel)

This project has a separate Express API and Vite frontend, so deploy them as two services.

### 1. Push to GitHub

Create a **public** empty repository named `minimi-research-agent` (do not add a README, license, or .gitignore). In PowerShell, from the extracted project folder run:

```powershell
git init
git add .
git commit -m "Initial Minimi research agent"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/minimi-research-agent.git
git push -u origin main
```

Never commit `.env`; `.gitignore` excludes it.

### 2. Deploy the API on Render

1. Sign in to Render → **New → Blueprint**.
2. Connect the repository and select `render.yaml`.
3. Create the `minimi-api` web service.
4. Add `OPENAI_API_KEY`, `TAVILY_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` in the Render Environment settings.
5. Set `CLIENT_ORIGIN` temporarily to `http://localhost:5173`; after Vercel deployment, replace it with the Vercel frontend origin.
6. Copy the deployed API URL (for example `https://minimi-api.onrender.com`).

### 3. Deploy the frontend on Vercel

1. Sign in to Vercel → **Add New → Project**.
2. Import the same GitHub repository.
3. Set **Root Directory** to `client`; framework preset **Vite**; build command `npm run build`; output directory `dist`.
4. Add `VITE_API_BASE_URL` with the Render API URL (no trailing slash).
5. Deploy. Copy the Vercel website origin, then update Render's `CLIENT_ORIGIN` to that exact origin and redeploy the API.

### 4. Verify

- Open `https://YOUR-API-URL/api/health`. It should return `status: "ok"` after all API secrets are configured.
- Open the Vercel website and send a test message.
- Refresh and confirm the conversation history is still present.

**Secrets:** Put the four server keys only in Render, never in frontend variables. Only `VITE_API_BASE_URL` belongs in Vercel. The demo uses UUID conversation handles, not production authentication; add Supabase Auth and ownership policies before storing sensitive conversations.
