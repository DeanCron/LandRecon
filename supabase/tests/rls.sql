-- RLS proof with two users. Run against a scratch Supabase/Postgres DB that
-- has the migration applied, as a superuser:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.sql
-- Everything runs in a transaction and is rolled back.
begin;

insert into auth.users (id, aud, role, email)
values ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'a@example.test'),
       ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'b@example.test');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
insert into public.saved_analyses (payload) values ('{"n":1}');
insert into public.dev_todos (items) values ('[]');

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', true);
do $$
begin
  if (select count(*) from public.saved_analyses) <> 0 then raise exception 'B can read A saved_analyses'; end if;
  if (select count(*) from public.dev_todos) <> 0 then raise exception 'B can read A dev_todos'; end if;
  update public.saved_analyses set payload = '{"hacked":true}';
  if found then raise exception 'B updated A row'; end if;
  delete from public.saved_analyses;
  if found then raise exception 'B deleted A row'; end if;
  begin
    insert into public.saved_analyses (user_id, payload) values ('00000000-0000-0000-0000-0000000000a1', '{}');
    raise exception 'B inserted as A';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- 5-row cap
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
begin
  for i in 2..5 loop insert into public.saved_analyses (payload) values ('{}'); end loop;
  begin
    insert into public.saved_analyses (payload) values ('{}');
    raise exception 'cap not enforced';
  exception when check_violation then null;
  end;
end $$;

-- anon gets nothing
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.saved_analyses;
    raise exception 'anon can select';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
