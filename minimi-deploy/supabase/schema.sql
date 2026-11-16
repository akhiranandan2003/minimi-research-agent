-- Run this in Supabase SQL Editor.
-- Existing anonymous demo rows cannot be safely assigned to an account. They remain
-- inaccessible after this migration; new inserts must always include the authenticated user.

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Upgrade an earlier demo schema without guessing who owns its old messages.
alter table public.messages
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- NOT VALID leaves legacy null rows untouched but enforces non-null user_id on every
-- new/updated row. On a fresh install the column is already NOT NULL.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.messages'::regclass
      and conname = 'messages_user_id_required'
  ) then
    alter table public.messages
      add constraint messages_user_id_required check (user_id is not null) not valid;
  end if;
end $$;

create index if not exists messages_user_conversation_created_idx
  on public.messages (user_id, conversation_id, created_at desc);

-- Supports retrieval of older, topic-matching messages within the same account and chat.
create index if not exists messages_content_fts_idx
  on public.messages using gin (to_tsvector('english', content));

alter table public.messages enable row level security;
alter table public.messages force row level security;

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own
  on public.messages for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own
  on public.messages for insert to authenticated
  with check (auth.uid() = user_id);

revoke all on public.messages from anon;
grant usage on schema public to authenticated;
grant select, insert on public.messages to authenticated;
grant usage, select on sequence public.messages_id_seq to authenticated;
