# Minimi Research Agent — Design

## Architecture

A React + Vite single-page chat client calls a Node.js + Express API. The API is the trust boundary: it validates requests, loads actual prior messages from Supabase PostgreSQL, invokes OpenAI's Responses API, executes the one allowed external tool (Tavily web search), and persists the resulting assistant message and source metadata. The browser never receives provider or database secrets. Each conversation is identified by a random UUID; this is a demo conversation handle, not user authentication.

## Why this design

- **React + Vite:** small, familiar client with fast local development and a single `npm run dev` command.
- **Express on Node:** keeps secrets and tool execution server-side and makes request validation/error handling explicit.
- **OpenAI Responses API:** supports structured function calling; the app exposes exactly one function, `web_search`.
- **Tavily:** dedicated search provider; results are treated as untrusted evidence and passed back to the model with prompt-injection warnings.
- **Supabase PostgreSQL:** durable, queryable message history. The server retrieves stored messages before answering historical questions instead of fabricating memory.

## Memory, citations, and temporal questions

The API loads the most recent 40 stored messages in chronological order. Historical questions are answered only from those records; missing details must be acknowledged. Temporal questions are instructed to identify relevant prior facts, search for dated evidence, compare like-for-like metrics/units/geographies, cite sources, and disclose uncertainty. Search sources are de-duplicated and returned to the UI as clickable links.

## Alternatives considered

- **OpenAI hosted web search:** simpler, but Tavily was selected to satisfy the requested explicit external-search integration and keep the tool boundary visible in the code.
- **Vector database / embeddings:** deferred. A bounded chronological history is simpler and auditable for this challenge; semantic retrieval can be added after relevance tests show it is needed.
- **Agent framework:** deferred in favor of a small explicit tool loop so the single-tool constraint and error paths are easy to inspect.

## What another week would improve

Add Supabase Auth and per-user conversation ownership/RLS; implement relevance-ranked memory retrieval with exact message references; add robust date-aware extraction and structured comparison tables; stream tokens; add retries, rate limits, request tracing, evaluation fixtures, and end-to-end tests; improve accessibility and mobile UI; add CI and deploy only after secrets and RLS are reviewed.
