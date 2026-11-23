# Minimi Research Agent — Design

## Architecture
A React + Vite client signs users in with Supabase Auth and sends their access token to a Node.js + Express API. The API verifies the token, creates a user-scoped Supabase client, manages an owner-scoped conversation list, retrieves that conversation's real message rows, calls OpenAI Responses, executes one model-visible external tool (`web_search`, backed by Tavily), and stores the answer and source metadata. PostgreSQL RLS and composite ownership constraints protect conversations and messages.

## Key decisions
- **React + Vite:** small client; root `npm install` and `npm run dev` run the API and UI together.
- **Express + Node:** secrets, validation, auth checks, rate limiting, and bounded tool execution stay server-side.
- **OpenAI Responses API:** explicit function calling keeps the one-tool boundary inspectable.
- **Tavily:** the only external tool exposed to the model. Retrieved pages are untrusted evidence, never instructions.
- **Supabase Auth + PostgreSQL:** verified user JWTs flow into database requests, so RLS applies. Conversations and messages have owner-scoped policies; a composite foreign key prevents a message from being attached to another user's conversation.
- **Injected orchestration:** provider adapters are separated from the runner, enabling deterministic tests without live API credentials.

## Memory, citations, and temporal questions
Recent messages plus up to 30 older full-text matches are retrieved from the same user's conversation and ordered chronologically. Memory is only actual database content; no synthetic recollections are created. History-only questions cannot call web search. Temporal comparisons derive explicit target periods from the question (two named years, a named year plus latest, or baseline plus latest). Search-query intent selects which requested side a result is meant to substantiate, but the matching period must still appear in returned source text; query wording alone never counts as evidence. For open-ended then/now comparisons, a recent publication cue plus current/latest source text is distinguished from an older baseline so a recent 2025 report is not automatically classified as historical merely because the calendar year is 2026. Publication date is not treated as the data observation date. This is only a retrieval gate—the model must still extract and compare actual observation dates, metric, unit, geography, population, and scope. If a period is absent or comparability cannot be established after bounded rounds, the final-answer guard prohibits an unsupported trend calculation. Citation references are validated against de-duplicated HTTP(S) sources before persistence.

## Alternatives considered
- **Service-role Supabase access:** rejected for normal chat requests because it bypasses RLS; user-JWT clients preserve database policy enforcement.
- **Vector memory:** deferred; PostgreSQL full-text search is inexpensive, auditable, and adequate for the first version.
- **Agent framework or hosted search:** deferred in favor of a small explicit tool loop and one independently testable Tavily adapter.

## What another week would improve
Replace the in-memory per-process rate limiter with Redis for multi-instance deployments; add streaming, tracing, stronger retrieval relevance scoring, and message-level memory citations; run staging tests against real providers; and improve mobile accessibility. Evaluate temporal comparisons against a fixed dated benchmark, including stale publications and pages whose publication year differs from their observation period, before expanding agent behavior. CI runs backend tests and the frontend production build on pushes and pull requests.
