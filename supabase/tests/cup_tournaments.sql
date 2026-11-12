-- Run only in a NEW, EMPTY, disposable local PostgreSQL database as superuser:
--   createdb futbol5_sql_test
--   psql -X -v ON_ERROR_STOP=1 -d futbol5_sql_test -f supabase/tests/cup_tournaments.sql
-- Uses no production connection, extensions, app credentials or pgTAP.
-- The database name must start with futbol5_sql_test. Objects remain for inspection.
\set ON_ERROR_STOP on

-- Refuse to bootstrap against an existing application database.
do $$
begin
  if current_database() not like 'futbol5\_sql\_test%' escape '\'
    or to_regclass('public.tournament_state') is not null
    or to_regclass('public.cup_onsites') is not null
    or to_regclass('public.cup_tournaments') is not null
  then
    raise exception 'Use a NEW disposable database named futbol5_sql_test*';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated;
create publication supabase_realtime;

-- Emulate Supabase's broad defaults: the migration must explicitly narrow them.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;

create schema cup_test;
grant usage on schema cup_test to anon, authenticated;

create function cup_test.assert_true(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAIL: %', p_message;
  end if;
end;
$$;

create function cup_test.expect_error(p_sql text, p_code text)
returns void language plpgsql as $$
declare
  v_code text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_code = returned_sqlstate;

    if v_code = p_code then
      return;
    end if;

    raise exception 'Expected SQLSTATE %, got % for %: %', p_code, v_code, p_sql, sqlerrm;
  end;

  raise exception 'Expected SQLSTATE %, but command succeeded: %', p_code, p_sql;
end;
$$;

\ir ../migrations/20261111164946_create_tournament_state.sql

-- Representative legacy data, not a production export. Include every original
-- field plus timers, a non-default order, penalties and opaque future metadata.
update public.tournament_state set version = 84, state = '{
  "names":["T1","T2","T3"],
  "m":[
    {"h":0,"a":1,"hs":3,"as":1,"done":true,"endsAt":null,"remaining":null},
    {"h":2,"a":0,"hs":2,"as":0,"done":true,"remaining":5000},
    {"h":1,"a":2,"hs":1,"as":4,"done":true,"endsAt":1794492000000},
    {"h":1,"a":0,"hs":2,"as":2,"done":true},
    {"h":0,"a":2,"hs":0,"as":1,"done":true},
    {"h":2,"a":1,"hs":2,"as":1,"done":true}
  ],
  "fin":{"hs":2,"as":2,"done":true,"pen":2,"endsAt":null,"remaining":1234},
  "tb":[2,0],"order":[1,0,2,4,3,5],"start":"19:15","dur":17,"gap":3,
  "extra":{"keep":[1,null,"opaque"]}
}' where id = 1;

create table cup_test.legacy_before as table public.tournament_state;

\ir ../migrations/20261112180000_create_cup_tournaments.sql

select cup_test.assert_true(
  (select (t.state - 'teams') = s.state and t.version = s.version
    and t.id = '22222222-2222-4222-8222-222222222222'
    and t.onsite_id = '11111111-1111-4111-8111-111111111111'
    and t.name = 'Buenos Aires Nov 26 Cup'
    from public.cup_tournaments t cross join cup_test.legacy_before s
    where t.legacy_source_id = 1),
  'all legacy fields and version are copied exactly');

select cup_test.assert_true(
  (select row(t.*) = row(s.*) from public.tournament_state t cross join cup_test.legacy_before s),
  'original legacy row is unchanged');

select cup_test.assert_true(
  (select name = 'Buenos Aires · Nov 2026' from public.cup_onsites
    where id = '11111111-1111-4111-8111-111111111111'),
  'seed onsite has the specified identity and label');

-- Verify ALL hardcoded names, roster order, stable IDs and captain flags.
select cup_test.assert_true(
  (select state->'teams' = '[
    {"id":"team-0","name":"Julian''s Old Boys","players":[
      {"id":"team-0-player-0","captain":true,"name":"Julian"},
      {"id":"team-0-player-1","captain":false,"name":"Facu B"},
      {"id":"team-0-player-2","captain":false,"name":"Fabri"},
      {"id":"team-0-player-3","captain":false,"name":"Okt"},
      {"id":"team-0-player-4","captain":false,"name":"Marin"}
    ]},
    {"id":"team-1","name":"La Triple Alianza","players":[
      {"id":"team-1-player-0","captain":true,"name":"Fernanda"},
      {"id":"team-1-player-1","captain":false,"name":"Uri"},
      {"id":"team-1-player-2","captain":false,"name":"Luca"},
      {"id":"team-1-player-3","captain":false,"name":"Facu M"},
      {"id":"team-1-player-4","captain":false,"name":"Mati"}
    ]},
    {"id":"team-2","name":"Manchester Unreconciled","players":[
      {"id":"team-2-player-0","captain":true,"name":"Kenny"},
      {"id":"team-2-player-1","captain":false,"name":"Tincho"},
      {"id":"team-2-player-2","captain":false,"name":"Ivan"},
      {"id":"team-2-player-3","captain":false,"name":"Melissa"},
      {"id":"team-2-player-4","captain":false,"name":"Ez"}
    ]}
  ]'::jsonb from public.cup_tournaments where legacy_source_id = 1),
  'seed squads match index.html exactly');

select cup_test.assert_true(
  not exists (select 1 from public.cup_tournaments t,
    lateral jsonb_array_elements((t.state->'m') || jsonb_build_array(t.state->'fin')) m
    where m ? 'goals'),
  'no goal records or scorer attributions are fabricated');

create table cup_test.seed_before as table public.cup_tournaments;

\ir ../migrations/20261112180000_create_cup_tournaments.sql

select cup_test.assert_true(
  (select row(t.*) = row(s.*) from public.cup_tournaments t cross join cup_test.seed_before s),
  'immediate migration retry changes nothing');

-- An empty-score state for creation tests, including the new goal arrays.
create table cup_test.fresh as
select jsonb_set(jsonb_set(jsonb_set(jsonb_set(state,
  '{m}', (select jsonb_agg(jsonb_build_object(
    'a', value->'a', 'as', 0, 'done', false, 'goals', '[]'::jsonb,
    'h', value->'h', 'hs', 0) order by ordinality)
    from jsonb_array_elements(state->'m') with ordinality)),
  '{fin}', '{"hs":0,"as":0,"done":false,"pen":null,"goals":[]}'),
  '{tb}', '[]'), '{order}', '[0,1,2,3,4,5]') as state
from public.cup_tournaments where legacy_source_id = 1;

grant select on cup_test.fresh to anon, authenticated;

select cup_test.assert_true((select public.cup_state_is_valid(state) from cup_test.fresh),
  'fresh state is valid');

-- Negative shape tests also exercise SQL NULL handling (CHECK must not leak NULL).
do $$
declare
  v_state jsonb := (select state from cup_test.fresh);
  v_bad jsonb;
begin
  foreach v_bad in array array[
    null::jsonb, 'null'::jsonb, '{}'::jsonb, '[]'::jsonb,
    v_state - 'start',
    jsonb_set(v_state, '{teams}', '[]'),
    jsonb_set(v_state, '{m}', '[]'),
    jsonb_set(v_state, '{m,0,h}', '2'),
    jsonb_set(v_state, '{m,0,hs}', '-1'),
    jsonb_set(v_state, '{m,0,done}', 'null'),
    jsonb_set(v_state, '{fin,pen}', '9'),
    jsonb_set(v_state, '{order}', '[0,0,1,2,3,4]'),
    jsonb_set(v_state, '{tb}', '[1,1]'),
    jsonb_set(v_state, '{start}', '"24:00"'),
    jsonb_set(v_state, '{dur}', '0'),
    jsonb_set(v_state, '{gap}', '31'),
    jsonb_set(v_state, '{teams,0,id}', '"team-9"'),
    jsonb_set(v_state, '{teams,0,name}', '" "'),
    jsonb_set(v_state, '{teams,0,players,0,captain}', '"true"'),
    jsonb_set(v_state, '{teams,0,players,1,id}', '"team-0-player-0"'),
    jsonb_set(v_state, '{m,0,goals}', '[{"id":"g","playerId":null}]'),
    jsonb_set(v_state, '{m,0,goals}', '[{"id":"g","playerId":null,"side":"home"}]'),
    jsonb_set(v_state, '{fin,goals}', '[{"id":"g","playerId":"missing","side":"hs"}]')
  ] loop
    perform cup_test.assert_true(public.cup_state_is_valid(v_bad) is false,
      'invalid state rejected: ' || coalesce(v_bad::text, 'SQL NULL'));
  end loop;

  perform cup_test.assert_true(public.cup_state_is_valid(jsonb_set(v_state, '{m,0,goals}',
    '[{"id":"g1","playerId":"team-0-player-0","side":"hs"},{"id":"g2","playerId":null,"side":"as"}]')),
    'known and unknown goal scorers accepted');

  perform cup_test.assert_true(public.cup_state_is_valid(jsonb_set(v_state, '{fin,goals}',
    '[{"id":"final-g1","playerId":"team-2-player-0","side":"as"}]')),
    'final goal records accepted');
end;
$$;

-- Test each browser role through RLS, not just as the table owner.
do $$
declare
  v_role text;
  v_column text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    perform cup_test.assert_true(has_table_privilege(v_role, 'public.cup_onsites', 'SELECT')
      and has_table_privilege(v_role, 'public.cup_tournaments', 'SELECT'), 'browser SELECT');

    perform cup_test.assert_true(not has_table_privilege(v_role, 'public.cup_tournaments', 'UPDATE')
      and has_column_privilege(v_role, 'public.cup_tournaments', 'state', 'UPDATE')
      and has_column_privilege(v_role, 'public.cup_tournaments', 'version', 'UPDATE'),
      'only narrow tournament UPDATE grants');

    foreach v_column in array array['id', 'onsite_id', 'name', 'legacy_source_id'] loop
      perform cup_test.assert_true(not has_column_privilege(v_role,
        'public.cup_tournaments', v_column, 'UPDATE'), 'immutable column: ' || v_column);
    end loop;

    perform cup_test.assert_true(not has_column_privilege(v_role,
      'public.cup_tournaments', 'legacy_source_id', 'INSERT')
      and not has_column_privilege(v_role, 'public.cup_tournaments', 'version', 'INSERT'),
      'browser cannot insert legacy IDs or initial version');

    perform cup_test.assert_true(not has_table_privilege(v_role, 'public.cup_onsites', 'UPDATE')
      and not has_table_privilege(v_role, 'public.cup_onsites', 'DELETE')
      and not has_table_privilege(v_role, 'public.cup_tournaments', 'DELETE')
      and not has_table_privilege(v_role, 'public.cup_tournaments', 'TRUNCATE')
      and not has_table_privilege(v_role, 'public.cup_onsites', 'TRUNCATE'),
      'no browser rename, delete or truncate');

    execute format('set local role %I', v_role);

    perform cup_test.assert_true((select count(*) = 1 from public.cup_tournaments),
      'RLS allows browser reads');

    perform cup_test.expect_error('delete from public.cup_tournaments', '42501');
    perform cup_test.expect_error('delete from public.cup_onsites', '42501');
    perform cup_test.expect_error('update public.cup_tournaments set name = ''Changed''', '42501');
    perform cup_test.expect_error('update public.cup_tournaments set legacy_source_id = 2', '42501');
    perform cup_test.expect_error('update public.cup_tournaments set state = ''{}''', '42501');
    perform cup_test.expect_error('update public.cup_onsites set name = ''Changed''', '42501');
    perform cup_test.expect_error('insert into public.cup_tournaments
      (id, onsite_id, name, state, legacy_source_id) values (
        ''90000000-0000-4000-8000-000000000001'',
        ''11111111-1111-4111-8111-111111111111'', ''Spoof'', ''{}'', 2)', '42501');

    execute 'reset role';
  end loop;
end;
$$;

set role anon;

select cup_test.assert_true(public.create_cup_tournament(
  '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
  null, ' Existing onsite cup ', (select state from cup_test.fresh))
  = '33333333-3333-4333-8333-333333333333', 'RPC uses an existing onsite');

select cup_test.assert_true(public.create_cup_tournament(
  '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
  ' New Onsite ', 'New cup', (select state from cup_test.fresh))
  = '44444444-4444-4444-8444-444444444444', 'RPC creates an onsite and tournament');

-- A retry returns the original ID before inspecting changed/invalid arguments.
select cup_test.assert_true(public.create_cup_tournament(
  '44444444-4444-4444-8444-444444444444', '66666666-6666-4666-8666-666666666666',
  'Unwanted retry onsite', 'Replacement cup', '{}'::jsonb)
  = '44444444-4444-4444-8444-444444444444', 'RPC is idempotent');

select cup_test.assert_true(
  not exists (select 1 from public.cup_onsites where name = 'Unwanted retry onsite')
  and (select name = 'New cup' and version = 0 and legacy_source_id is null
    from public.cup_tournaments where id = '44444444-4444-4444-8444-444444444444'),
  'retry neither replaces tournament nor creates another onsite');

select public.create_cup_tournament(
  '77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666',
  ' nEW oNSITE ', 'Same onsite cup', (select state from cup_test.fresh));

select cup_test.assert_true(
  (select onsite_id = '55555555-5555-4555-8555-555555555555'
    from public.cup_tournaments where id = '77777777-7777-4777-8777-777777777777')
  and not exists (select 1 from public.cup_onsites where id = '66666666-6666-4666-8666-666666666666'),
  'case-insensitive onsite match uses the actual existing UUID');

select cup_test.expect_error($sql$select public.create_cup_tournament(
  '88888888-8888-4888-8888-888888888888', '66666666-6666-4666-8666-666666666666',
  null, 'Missing onsite', (select state from cup_test.fresh))$sql$, '22023');

select cup_test.expect_error($sql$select public.create_cup_tournament(
  '88888888-8888-4888-8888-888888888888', '55555555-5555-4555-8555-555555555555',
  'Different name', 'Conflict', (select state from cup_test.fresh))$sql$, '22023');

select cup_test.expect_error($sql$select public.create_cup_tournament(
  '88888888-8888-4888-8888-888888888888', '66666666-6666-4666-8666-666666666666',
  'Invalid state onsite', 'Invalid', '{}')$sql$, '22023');

select cup_test.expect_error($sql$select public.create_cup_tournament(
  '88888888-8888-4888-8888-888888888888', '66666666-6666-4666-8666-666666666666',
  'Name test', repeat('x', 121), (select state from cup_test.fresh))$sql$, '22023');

select cup_test.expect_error($sql$select public.create_cup_tournament(
  '88888888-8888-4888-8888-888888888888', '66666666-6666-4666-8666-666666666666',
  ' ', 'Name test', (select state from cup_test.fresh))$sql$, '22023');

select cup_test.assert_true((select count(*) = 2 from public.cup_onsites),
  'failed RPCs leave no partial onsite');

-- Direct INSERT is necessarily allowed with SECURITY INVOKER, but cannot bypass
-- state validation or create an orphaned tournament.
select cup_test.expect_error($sql$insert into public.cup_tournaments (id, onsite_id, name, state)
  values ('88888888-8888-4888-8888-888888888888',
    '11111111-1111-4111-8111-111111111111', 'Bad direct state', '{}')$sql$, '23514');

select cup_test.expect_error($sql$insert into public.cup_tournaments (id, onsite_id, name, state)
  select '88888888-8888-4888-8888-888888888888',
    '66666666-6666-4666-8666-666666666666', 'Missing FK', state from cup_test.fresh$sql$, '23503');

-- Compare-and-swap: one save succeeds; the stale writer sees zero updated rows.
with saved as (
  update public.cup_tournaments set state = jsonb_set(state, '{gap}', '4'), version = 85
  where id = '22222222-2222-4222-8222-222222222222' and version = 84 returning id
)
select cup_test.assert_true((select count(*) = 1 from saved), 'CAS saves expected version');

with stale as (
  update public.cup_tournaments set state = jsonb_set(state, '{gap}', '5'), version = 85
  where id = '22222222-2222-4222-8222-222222222222' and version = 84 returning id
)
select cup_test.assert_true((select count(*) = 0 from stale), 'stale CAS cannot overwrite');

reset role;

-- Inject a failure AFTER the RPC inserts an onsite to verify real rollback,
-- rather than only checking validation failures that occur before any writes.
create function cup_test.fail_insert()
returns trigger language plpgsql as $$
begin
  if new.id = '88888888-8888-4888-8888-888888888888'::uuid then
    raise exception 'Injected tournament write failure' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger cup_test_fail_insert before insert on public.cup_tournaments
  for each row execute function cup_test.fail_insert();

set role anon;

select cup_test.expect_error($sql$select public.create_cup_tournament(
  '88888888-8888-4888-8888-888888888888', '66666666-6666-4666-8666-666666666666',
  'Must roll back', 'Failed cup', (select state from cup_test.fresh))$sql$, '23514');

select cup_test.assert_true(
  not exists (select 1 from public.cup_onsites where name = 'Must roll back')
  and not exists (select 1 from public.cup_tournaments
    where id = '88888888-8888-4888-8888-888888888888'),
  'RPC rolls back a newly inserted onsite when tournament insertion fails');

reset role;
drop trigger cup_test_fail_insert on public.cup_tournaments;
drop function cup_test.fail_insert();

set role authenticated;

select public.create_cup_tournament(
  '99999999-9999-4999-8999-999999999999', '11111111-1111-4111-8111-111111111111',
  null, 'Authenticated cup', (select state from cup_test.fresh));

update public.cup_tournaments set version = 1,
  state = jsonb_set(state, '{fin,goals}', '[{"id":"f-g","playerId":null,"side":"hs"}]')
  where id = '99999999-9999-4999-8999-999999999999' and version = 0;

select cup_test.assert_true((select version = 1 from public.cup_tournaments
  where id = '99999999-9999-4999-8999-999999999999'), 'authenticated create and edit');

reset role;

select cup_test.assert_true(
  (select row(t.*) = row(s.*) from public.tournament_state t cross join cup_test.legacy_before s)
  and (select version = 0 and state = (select state from cup_test.fresh)
    from public.cup_tournaments where id = '33333333-3333-4333-8333-333333333333'),
  'new tournament creation and edits do not modify other tournaments or legacy state');

create table cup_test.edited_before as table public.cup_tournaments;

-- Simulate later writes by the old app as well as edits to the new app.
update public.tournament_state set version = 97, state = jsonb_set(state, '{gap}', '7');

\ir ../migrations/20261112180000_create_cup_tournaments.sql

select cup_test.assert_true(
  not exists ((table public.cup_tournaments except table cup_test.edited_before)
    union all (table cup_test.edited_before except table public.cup_tournaments))
  and (select version = 85 and state->'gap' = '4'::jsonb from public.cup_tournaments
    where legacy_source_id = 1),
  'migration retry preserves all new-app edits despite a changed legacy source');

select cup_test.assert_true(
  (select count(*) = 3 from pg_publication_tables where pubname = 'supabase_realtime'
    and schemaname = 'public' and tablename in ('tournament_state', 'cup_onsites', 'cup_tournaments')),
  'realtime memberships are present and not duplicated');

select cup_test.assert_true(
  not (select prosecdef from pg_proc
    where oid = 'public.create_cup_tournament(uuid,uuid,text,text,jsonb)'::regprocedure)
  and not exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a
    where p.oid = 'public.create_cup_tournament(uuid,uuid,text,text,jsonb)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  'RPC is invoker-only and has no PUBLIC execute grant');

-- Finally verify a clean install after the original migration's default {} row.
-- Only this disposable test database is cleared; no production export is used.
drop table public.cup_tournaments;
drop table public.cup_onsites;
update public.tournament_state set state = '{}', version = 0;

\ir ../migrations/20261112180000_create_cup_tournaments.sql

select cup_test.assert_true(
  (select (state - 'teams') = '{}'::jsonb and version = 0 from public.cup_tournaments
    where legacy_source_id = 1),
  'fresh database legacy default is preserved without rebuilding state');

\echo All cup tournament SQL validations passed.
