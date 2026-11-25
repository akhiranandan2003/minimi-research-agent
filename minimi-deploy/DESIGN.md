# Minimi Research Agent — Design

## Architecture
The React + Vite client uses Supabase Auth and sends the user's access token to a Node.js + Express API. The API verifies the token, creates a user-scoped Supabase client, checks conversation ownership, retrieves stored messages, calls OpenAI Responses, and persists replies with source metadata. PostgreSQL Row Level Security and a composite ownership foreign key protect conversations and messages.

The agent exposes exactly one model-visible external tool: `web_search`, implemented with Tavily. OpenAI handles response generation and structured extraction; Supabase stores durable conversation history. The browser receives only the Supabase publishable/anon key. Provider SDKs are isolated behind injected adapters so orchestration can be tested without live credentials.

## Key decisions
- **React + Vite:** small client and fast build; root `npm install` and `npm run dev` start both workspaces.
- **Node + Express:** authentication, secrets, validation, rate limiting, and bounded tool execution stay server-side.
- **OpenAI Responses function calling:** a small explicit tool loop makes the one-tool boundary easy to inspect and test.
- **Tavily:** one search adapter returns normalized HTTP(S) sources with stable citation numbers.
- **Supabase Auth + PostgreSQL:** user JWTs preserve RLS; owner filters and database constraints provide defense in depth.
- **PostgreSQL full-text memory:** actual messages are retrieved from the selected user's conversation; no synthetic memories are created. History-only questions cannot search the web.

## Research correctness and safety
Search results and stored messages are treated as untrusted evidence, never instructions. Citations must refer to retrieved sources. Temporal questions retrieve relevant prior context, identify two target periods, and search each side separately. Query wording or publication dates alone do not establish an observation period.

Before a temporal answer is accepted, OpenAI returns strict-schema evidence: metric, value, unit, observation period, geography, population, scope, citation, and an exact quote. Server validation checks quote provenance, values, dates, citation ownership, and like-for-like dimensions. It also checks arithmetic, direction, and units (percentage-point differences versus relative percentages). Conversation evidence retains user/assistant provenance. If extraction, comparison, citation, or arithmetic checks fail, the server returns a deterministic uncertainty response rather than an unstructured model fallback. The extractor has no tools; Tavily web search remains the only external tool.

## Alternatives considered
- **Supabase service-role access:** rejected for normal chat because it bypasses RLS; user-scoped JWT clients are safer.
- **Vector database:** deferred; PostgreSQL full-text search is simpler, auditable, and adequate for the first version.
- **Agent framework or hosted search tool:** deferred; explicit orchestration and one Tavily adapter are easier to audit.

## What another week would improve
Replace the per-process rate limiter with Redis before multi-instance deployment; add streaming, tracing, stronger retrieval ranking, and message-level memory citations. Run staging tests with real OpenAI, Tavily, and Supabase credentials. Evaluate temporal extraction against a dated benchmark covering stale sources, mismatched units, geography, population, scope, and publication-versus-observation dates. Improve mobile accessibility.
