begin;

-- Shared-link access is intentional. This is not an authentication boundary.
-- Keep the legacy table, row and migration intact for rollback and old clients.
create or replace function public.cup_state_is_valid(p_state jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_team jsonb;
  v_player jsonb;
  v_match jsonb;
  v_goal jsonb;
  v_player_ids text[] := '{}';
  v_goal_ids text[];
  v_index integer := 0;
  v_fixtures jsonb := '[[0,1],[2,0],[1,2],[1,0],[0,2],[2,1]]';
begin
  if jsonb_typeof(p_state) is distinct from 'object'
    or jsonb_typeof(p_state->'teams') is distinct from 'array'
    or jsonb_typeof(p_state->'m') is distinct from 'array'
    or jsonb_typeof(p_state->'fin') is distinct from 'object'
    or jsonb_typeof(p_state->'order') is distinct from 'array'
    or jsonb_typeof(p_state->'tb') is distinct from 'array'
    or jsonb_typeof(p_state->'start') is distinct from 'string'
    or jsonb_typeof(p_state->'dur') is distinct from 'number'
    or jsonb_typeof(p_state->'gap') is distinct from 'number'
  then
    return false;
  end if;

  if jsonb_array_length(p_state->'teams') <> 3
    or jsonb_array_length(p_state->'m') <> 6
    or jsonb_array_length(p_state->'order') <> 6
    or (p_state->>'start') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
    or (p_state->>'dur')::numeric not between 1 and 90
    or (p_state->>'gap')::numeric not between 0 and 30
  then
    return false;
  end if;

  if (select jsonb_agg(value order by value) from jsonb_array_elements(p_state->'order'))
    is distinct from '[0,1,2,3,4,5]'::jsonb
    or exists (select 1 from jsonb_array_elements(p_state->'tb') as t(value)
      where value not in ('0'::jsonb, '1'::jsonb, '2'::jsonb))
    or (select count(*) <> count(distinct value) from jsonb_array_elements(p_state->'tb'))
  then
    return false;
  end if;

  for v_team in select value from jsonb_array_elements(p_state->'teams') loop
    if jsonb_typeof(v_team) is distinct from 'object'
      or v_team->'id' is distinct from to_jsonb('team-' || v_index)
      or jsonb_typeof(v_team->'name') is distinct from 'string'
      or char_length(btrim(v_team->>'name')) not between 1 and 120
      or jsonb_typeof(v_team->'players') is distinct from 'array'
    then
      return false;
    end if;

    for v_player in select value from jsonb_array_elements(v_team->'players') loop
      if jsonb_typeof(v_player) is distinct from 'object'
        or jsonb_typeof(v_player->'id') is distinct from 'string'
        or char_length(btrim(v_player->>'id')) = 0
        or (v_player->>'id') = any(v_player_ids)
        or jsonb_typeof(v_player->'name') is distinct from 'string'
        or char_length(btrim(v_player->>'name')) not between 1 and 120
        or jsonb_typeof(v_player->'captain') is distinct from 'boolean'
      then
        return false;
      end if;

      v_player_ids := array_append(v_player_ids, v_player->>'id');
    end loop;

    v_index := v_index + 1;
  end loop;

  v_index := 0;

  for v_match in
    select value from jsonb_array_elements((p_state->'m') || jsonb_build_array(p_state->'fin'))
  loop
    if jsonb_typeof(v_match) is distinct from 'object'
      or jsonb_typeof(v_match->'hs') is distinct from 'number'
      or jsonb_typeof(v_match->'as') is distinct from 'number'
      or (v_match->>'hs') !~ '^[0-9]+$'
      or (v_match->>'as') !~ '^[0-9]+$'
      or jsonb_typeof(v_match->'done') is distinct from 'boolean'
    then
      return false;
    end if;

    if v_index < 6 then
      if v_match->'h' is distinct from v_fixtures->v_index->0
        or v_match->'a' is distinct from v_fixtures->v_index->1
      then
        return false;
      end if;
    elsif not (v_match ? 'pen')
      or v_match->'pen' not in ('null'::jsonb, '0'::jsonb, '1'::jsonb, '2'::jsonb)
    then
      return false;
    end if;

    -- Historical scores need no invented goal records. The browser derives
    -- unattributed entries. When records exist, require explicit side/scorer.
    if v_match ? 'goals' then
      if jsonb_typeof(v_match->'goals') is distinct from 'array' then
        return false;
      end if;

      v_goal_ids := '{}';

      for v_goal in select value from jsonb_array_elements(v_match->'goals') loop
        if jsonb_typeof(v_goal) is distinct from 'object'
          or jsonb_typeof(v_goal->'id') is distinct from 'string'
          or char_length(btrim(v_goal->>'id')) = 0
          or (v_goal->>'id') = any(v_goal_ids)
          or not (v_goal ? 'side')
          or v_goal->'side' not in ('"hs"'::jsonb, '"as"'::jsonb)
          or not (v_goal ? 'playerId')
          or (v_goal->'playerId' <> 'null'::jsonb and (
            jsonb_typeof(v_goal->'playerId') is distinct from 'string'
            or not ((v_goal->>'playerId') = any(v_player_ids))
          ))
        then
          return false;
        end if;

        v_goal_ids := array_append(v_goal_ids, v_goal->>'id');
      end loop;
    end if;

    v_index := v_index + 1;
  end loop;

  return true;
end;
$$;

create table if not exists public.cup_onsites (
  id uuid primary key,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120)
);

create unique index if not exists cup_onsites_name_key
  on public.cup_onsites (lower(name));

create table if not exists public.cup_tournaments (
  id uuid primary key,
  onsite_id uuid not null references public.cup_onsites(id),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  -- Preserve even the original migration's empty legacy state verbatim.
  -- Browser writes still require a complete state through the RLS policies.
  state jsonb not null check (jsonb_typeof(state) = 'object'
    and (legacy_source_id is not null or public.cup_state_is_valid(state))),
  version integer not null default 0 check (version >= 0),
  legacy_source_id integer unique
);

alter table public.cup_onsites enable row level security;
alter table public.cup_tournaments enable row level security;

-- Revoke Supabase's possible default table ACLs before granting column access.
revoke all on public.cup_onsites, public.cup_tournaments from public, anon, authenticated;
grant select on public.cup_onsites, public.cup_tournaments to anon, authenticated;
grant insert (id, name) on public.cup_onsites to anon, authenticated;
grant insert (id, onsite_id, name, state) on public.cup_tournaments to anon, authenticated;
grant update (state, version) on public.cup_tournaments to anon, authenticated;

-- An invoker RPC requires INSERT privileges. Direct inserts are therefore also
-- possible, but share these CHECK/FK/unique constraints and cannot set legacy IDs.
drop policy if exists cup_onsites_select on public.cup_onsites;
create policy cup_onsites_select on public.cup_onsites
  for select to anon, authenticated using (true);

drop policy if exists cup_onsites_insert on public.cup_onsites;
create policy cup_onsites_insert on public.cup_onsites
  for insert to anon, authenticated with check (true);

drop policy if exists cup_tournaments_select on public.cup_tournaments;
create policy cup_tournaments_select on public.cup_tournaments
  for select to anon, authenticated using (true);

drop policy if exists cup_tournaments_insert on public.cup_tournaments;
create policy cup_tournaments_insert on public.cup_tournaments
  for insert to anon, authenticated with check (legacy_source_id is null and version = 0);

drop policy if exists cup_tournaments_update on public.cup_tournaments;
create policy cup_tournaments_update on public.cup_tournaments
  for update to anon, authenticated using (true)
    with check (public.cup_state_is_valid(state));

create or replace function public.create_cup_tournament(
  p_id uuid,
  p_onsite_id uuid,
  p_onsite_name text,
  p_name text,
  p_state jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_onsite_id uuid;
begin
  if p_id is null then
    raise exception 'Tournament ID is required' using errcode = '22023';
  end if;

  -- Serialize retries for the same tournament before creating an onsite.
  -- A concurrent retry must not leave an extra onsite behind.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));

  select id into v_id from public.cup_tournaments where id = p_id;

  if found then
    return v_id;
  end if;

  if p_onsite_id is null
    or p_name is null or char_length(btrim(p_name)) not between 1 and 120
    or not public.cup_state_is_valid(p_state)
  then
    raise exception 'Valid onsite ID, tournament name (1-120 characters) and state are required'
      using errcode = '22023';
  end if;

  if p_onsite_name is null then
    select id into v_onsite_id from public.cup_onsites where id = p_onsite_id;

    if not found then
      raise exception 'Onsite does not exist' using errcode = '22023';
    end if;
  else
    if char_length(btrim(p_onsite_name)) not between 1 and 120 then
      raise exception 'Onsite name must be 1-120 characters' using errcode = '22023';
    end if;

    select id into v_onsite_id from public.cup_onsites
      where lower(name) = lower(btrim(p_onsite_name));

    if not found then
      insert into public.cup_onsites (id, name)
        values (p_onsite_id, btrim(p_onsite_name))
        on conflict do nothing
        returning id into v_onsite_id;

      if not found then
        -- A different tournament may have created this name concurrently.
        select id into v_onsite_id from public.cup_onsites
          where lower(name) = lower(btrim(p_onsite_name));

        if not found then
          raise exception 'Onsite ID already belongs to another name' using errcode = '22023';
        end if;
      end if;
    end if;
  end if;

  insert into public.cup_tournaments (id, onsite_id, name, state)
    values (p_id, v_onsite_id, btrim(p_name), p_state);

  return p_id;
exception when unique_violation then
  -- A direct browser INSERT does not take the advisory lock. If it won this
  -- ID race, this exception block rolls back our onsite insertion as well.
  select id into v_id from public.cup_tournaments where id = p_id;

  if found then
    return v_id;
  end if;

  raise;
end;
$$;

revoke all on function public.cup_state_is_valid(jsonb) from public, anon, authenticated;
revoke all on function public.create_cup_tournament(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.cup_state_is_valid(jsonb) to anon, authenticated;
grant execute on function public.create_cup_tournament(uuid, uuid, text, text, jsonb)
  to anon, authenticated;

-- Lock out old-app writes for the duration of the copy and its verification.
-- Deployment must still coordinate cutover: old clients can write after commit.
do $$
declare
  v_source public.tournament_state%rowtype;
  v_copy public.cup_tournaments%rowtype;
  v_inserted integer;
  v_teams jsonb := '[
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
  ]';
begin
  select * into v_source from public.tournament_state where id = 1 for share;

  if not found then
    raise exception 'Legacy tournament row 1 is missing; stop rollout';
  end if;

  insert into public.cup_onsites (id, name)
    values ('11111111-1111-4111-8111-111111111111', 'Buenos Aires · Nov 2026')
    on conflict do nothing;

  if not exists (
    select 1 from public.cup_onsites
    where id = '11111111-1111-4111-8111-111111111111'
      and name = 'Buenos Aires · Nov 2026'
  ) then
    raise exception 'Legacy onsite seed conflicts with existing identity; stop rollout';
  end if;

  insert into public.cup_tournaments (id, onsite_id, name, state, version, legacy_source_id)
    values (
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'Buenos Aires Nov 26 Cup',
      v_source.state || jsonb_build_object('teams', v_teams),
      v_source.version,
      1
    ) on conflict do nothing;

  get diagnostics v_inserted = row_count;

  select * into v_copy from public.cup_tournaments
    where id = '22222222-2222-4222-8222-222222222222';

  if not found or v_copy.legacy_source_id is distinct from 1
    or v_copy.onsite_id is distinct from '11111111-1111-4111-8111-111111111111'::uuid
  then
    raise exception 'Legacy seed conflicts with existing tournament identity; stop rollout';
  end if;

  -- Never compare an already-seeded tournament to the source after app edits.
  if v_inserted = 1 and (
    (v_copy.state - 'teams') is distinct from (v_source.state - 'teams')
    or v_copy.state->'teams' is distinct from v_teams
    or v_copy.version is distinct from v_source.version
  ) then
    raise exception 'Legacy state or version did not copy exactly; stop rollout';
  end if;
end;
$$;

-- Keep the old publication membership; add both directory tables only once.
do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    foreach v_table in array array['cup_onsites', 'cup_tournaments'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

commit;
