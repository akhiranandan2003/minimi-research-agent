# Minimi Research Agent — Design

## Architecture

A React + Vite client signs users in with Supabase Auth and sends their access token to a Node.js + Express API. The API verifies the token, creates a user-scoped Supabase client, retrieves that user's real conversation rows, calls OpenAI Responses, executes one model-visible external tool (`web_search`, backed by Tavily), and stores the answer and source metadata. PostgreSQL RLS and explicit owner/conversation filters protect every message query.

## Key decisions

- **React + Vite:** small client; root `npm install` and `npm run dev` run the API and UI together.
- **Express + Node:** secrets, validation, auth checks, rate limiting, and bounded tool execution stay server-side.
- **OpenAI Responses API:** explicit function calling keeps the one-tool boundary inspectable.
- **Tavily:** the only external tool exposed to the model. Retrieved pages are untrusted evidence, never instructions.
- **Supabase Auth + PostgreSQL:** verified user JWTs flow into database requests, so RLS applies; owner and conversation filters provide defense in depth.
- **Injected orchestration:** provider adapters are separated from the runner, enabling deterministic tests without live API credentials.

## Memory, citations, and temporal questions

Recent messages plus up to 30 older full-text matches are retrieved from the same user's conversation and ordered chronologically. Memory is only actual database content; no synthetic recollections are created. History-only questions cannot call web search. Temporal comparisons combine relevant stored context with dated search evidence, require like-for-like metric/unit/geography/scope, and disclose uncertainty. Citation references are validated against deduplicated HTTP(S) sources before persistence.

## Alternatives considered

- **Service-role Supabase access:** rejected for normal chat requests because it bypasses RLS; user-JWT clients preserve database policy enforcement.
- **Vector memory:** deferred; PostgreSQL full-text search is inexpensive, auditable, and adequate for the first version.
- **Agent framework or hosted search:** deferred in favor of a small explicit tool loop and one independently testable Tavily adapter.

## What another week would improve

Replace the in-memory per-process rate limiter with Redis for multi-instance deployments; add streaming, tracing, stronger retrieval relevance scoring, and message-level memory citations; run staging tests against real providers; and improve mobile accessibility. Evaluate temporal comparisons against a fixed dated benchmark before expanding agent behavior. CI runs the backend tests and frontend production build on pushes and pull requests.
