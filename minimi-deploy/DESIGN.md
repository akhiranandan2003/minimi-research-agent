# Minimi Research Agent — Design

## Architecture

A React + Vite chat client calls a Node.js + Express API. The API validates requests, retrieves real conversation rows from Supabase PostgreSQL, calls OpenAI's Responses API, executes one model-visible external tool (web_search, backed by Tavily), and stores the assistant answer plus source metadata. Provider and database secrets remain on the server. Conversation UUIDs are demo handles, not authentication.

## Key decisions

- **React + Vite:** a small client and a single local npm run dev command.
- **Express + Node:** keeps secrets and search execution server-side; request validation and bounded tool loops are explicit.
- **OpenAI Responses API:** structured function calling without an agent framework obscuring the one-tool constraint.
- **Tavily:** the only external tool exposed to the model. Search results are untrusted evidence, never instructions.
- **Supabase PostgreSQL:** durable, inspectable message history; conversation/time and full-text indexes support recent context and older topic-matching messages.

## Memory, citations, and time comparisons

For each turn, the API loads recent messages plus up to 30 older messages matching important query terms, always filtered to the same conversation. These are actual database rows, ordered chronologically; no synthetic memory is created. Historical-only questions are not allowed to invoke web search. Temporal comparisons use relevant prior context and dated web sources, compare like-for-like metrics, units, geography, population, and scope, and disclose uncertainty. Citation numbers are checked against returned HTTP(S) sources before the answer is saved.

## Alternatives considered

- **OpenAI hosted search:** simpler, but Tavily makes the single external tool explicit and independently testable.
- **Vector database / embeddings:** deferred; PostgreSQL full-text retrieval is cheaper, auditable, and sufficient for this first memory slice.
- **Agent framework:** deferred; a bounded explicit tool loop is easier to inspect and test.

## What another week would improve

Add Supabase Auth and per-user ownership/RLS before production use; add relevance scoring and message-level memory citations; stream responses; add rate limits, tracing, end-to-end tests and CI; and improve mobile accessibility. Evaluate date extraction and temporal comparisons against a fixed benchmark before expanding agent behavior.