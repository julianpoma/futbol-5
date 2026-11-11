create table public.tournament_state (
  id integer primary key default 1 check (id = 1),
  state jsonb not null default '{}'::jsonb,
  version integer not null default 0
);

alter table public.tournament_state enable row level security;

create policy "Anyone can read tournament" on public.tournament_state
  for select to anon, authenticated using (true);

create policy "Anyone can update tournament" on public.tournament_state
  for update to anon, authenticated using (true) with check (id = 1);

grant select, update on public.tournament_state to anon, authenticated;

insert into public.tournament_state (id) values (1);

alter publication supabase_realtime add table public.tournament_state;
