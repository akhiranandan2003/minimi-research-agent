-- Run this in Supabase SQL Editor.
-- The browser never queries this table directly; only the Node API uses the server-side key.
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

-- Supports retrieval of older, topic-matching messages for historical questions.
create index if not exists messages_content_fts_idx
  on public.messages using gin (to_tsvector('english', content));

alter table public.messages enable row level security;

-- No anon/authenticated policies are created intentionally.
-- The server-side secret key bypasses RLS and must never be exposed to the frontend.

grant usage on schema public to service_role;
grant select, insert on table public.messages to service_role;