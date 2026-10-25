-- Per-user saved items for LandRecon. Every table has RLS enabled and
-- owner-only policies; the anon role gets nothing.

create table public.saved_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint saved_analyses_payload_size check (pg_column_size(payload) <= 262144)
);

create index saved_analyses_user_created_idx
  on public.saved_analyses (user_id, created_at desc);

create table public.dev_todos (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  checks jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint dev_todos_size check (pg_column_size(items) + pg_column_size(checks) <= 262144)
);

-- Keep the "max 5 saved analyses" rule server-side too.
create or replace function public.enforce_saved_analyses_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select count(*) from public.saved_analyses where user_id = new.user_id) >= 5 then
    raise exception 'saved_analyses limit (5) reached' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger saved_analyses_cap
  before insert on public.saved_analyses
  for each row execute function public.enforce_saved_analyses_cap();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger dev_todos_touch
  before update on public.dev_todos
  for each row execute function public.touch_updated_at();

alter table public.saved_analyses enable row level security;
alter table public.dev_todos enable row level security;

revoke all on public.saved_analyses, public.dev_todos from anon;
grant select, insert, update, delete on public.saved_analyses, public.dev_todos to authenticated;

create policy saved_analyses_select on public.saved_analyses
  for select to authenticated using (user_id = (select auth.uid()));
create policy saved_analyses_insert on public.saved_analyses
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy saved_analyses_update on public.saved_analyses
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_analyses_delete on public.saved_analyses
  for delete to authenticated using (user_id = (select auth.uid()));

create policy dev_todos_select on public.dev_todos
  for select to authenticated using (user_id = (select auth.uid()));
create policy dev_todos_insert on public.dev_todos
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy dev_todos_update on public.dev_todos
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy dev_todos_delete on public.dev_todos
  for delete to authenticated using (user_id = (select auth.uid()));
