-- Run this in Supabase SQL Editor.
-- Existing anonymous demo rows cannot be safely assigned to an account. They remain
-- inaccessible after this migration; rows with a verified user_id are backfilled below.

create table if not exists public.conversations (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Upgrade an earlier demo schema without guessing who owns anonymous rows.
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

-- Preserve existing authenticated conversations when upgrading from message-only storage.
insert into public.conversations (user_id, id, title, created_at, updated_at)
select
  m.user_id,
  m.conversation_id,
  coalesce(
    left((array_agg(m.content order by m.created_at, m.id) filter (where m.role = 'user'))[1], 80),
    'New chat'
  ),
  min(m.created_at),
  max(m.created_at)
from public.messages m
where m.user_id is not null
group by m.user_id, m.conversation_id
on conflict (user_id, id) do nothing;

-- Enforce that every new message belongs to a conversation owned by the same user.
-- NOT VALID permits legacy rows to remain while checking every new or changed row.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.messages'::regclass
      and conname = 'messages_conversation_owner_fk'
  ) then
    alter table public.messages
      add constraint messages_conversation_owner_fk
      foreign key (user_id, conversation_id)
      references public.conversations (user_id, id)
      on delete cascade not valid;
  end if;
end $$;

create index if not exists messages_user_conversation_created_idx
  on public.messages (user_id, conversation_id, created_at desc);

create index if not exists messages_content_fts_idx
  on public.messages using gin (to_tsvector('english', content));

alter table public.conversations enable row level security;
alter table public.conversations force row level security;
alter table public.messages enable row level security;
alter table public.messages force row level security;

drop policy if exists conversations_select_own on public.conversations;
create policy conversations_select_own
  on public.conversations for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists conversations_insert_own on public.conversations;
create policy conversations_insert_own
  on public.conversations for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists conversations_update_own on public.conversations;
create policy conversations_update_own
  on public.conversations for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own
  on public.messages for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own
  on public.messages for insert to authenticated
  with check (auth.uid() = user_id);

revoke all on public.conversations from anon;
revoke all on public.messages from anon;
grant usage on schema public to authenticated;
grant select, insert, update on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant usage, select on sequence public.messages_id_seq to authenticated;
