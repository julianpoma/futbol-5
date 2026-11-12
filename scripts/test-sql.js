import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { applyAction, freshState, LEGACY_ID, normalizeState, ONSITE_ID } from '../src/state.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function expandSql(path) {
  const lines = (await readFile(path, 'utf8')).split('\n');
  const output = [];
  for (const line of lines) {
    if (line.startsWith('\\ir ')) output.push(await expandSql(resolve(dirname(path), line.slice(4).trim())));
    else if (!line.startsWith('\\')) output.push(line);
  }
  return output.join('\n');
}

// PGlite runs PostgreSQL in memory. This script never uses a network connection.
const db = new PGlite();
try {
  // PGlite's only database is named postgres. Keep the table-absence guards,
  // but adapt the CLI-only database-name guard for this in-memory runtime.
  const suite = (await expandSql(resolve(root, 'supabase/tests/cup_tournaments.sql')))
    .replace('current_database() not like', "'futbol5_sql_test_pglite' not like");
  await db.exec(suite);
  console.log('PASS: SQL preservation, migration retries, RPC creation, RLS, grants and CAS suite');

  const legacy = JSON.parse(await readFile(resolve(root, 'tests/fixtures/legacy.json'), 'utf8'));
  await db.query('update public.tournament_state set state = $1, version = $2 where id = 1', [legacy.state, legacy.version]);
  await db.exec('drop table public.cup_tournaments; drop table public.cup_onsites;');
  await db.exec(await readFile(resolve(root, 'supabase/migrations/20261112180000_create_cup_tournaments.sql'), 'utf8'));
  const { rows: [copy] } = await db.query('select * from public.cup_tournaments where id = $1', [LEGACY_ID]);
  const { teams, ...original } = copy.state;
  assert.deepEqual(original, legacy.state);
  assert.equal(copy.version, legacy.version);

  await db.exec('set role anon;');
  const normalized = normalizeState(copy.state);
  await db.query('update public.cup_tournaments set state = $1, version = version + 1 where id = $2', [normalized, LEGACY_ID]);
  const fresh = freshState();
  const id = crypto.randomUUID();
  await db.query('select public.create_cup_tournament($1, $2, $3, $4, $5)', [id, ONSITE_ID, null, 'Frontend contract test', fresh]);
  let state = applyAction(fresh, { opId: crypto.randomUUID(), matchId: 0, playerId: fresh.teams[0].players[0].id, side: 'hs', type: 'goal' });
  state = applyAction(state, { opId: crypto.randomUUID(), matchId: 0, type: 'done' });
  await db.query('update public.cup_tournaments set state = $1, version = version + 1 where id = $2', [state, id]);
  const { rows: [saved] } = await db.query('select state from public.cup_tournaments where id = $1', [id]);
  assert.deepEqual(saved.state, state);
  console.log('PASS: Actual legacy fixture preserved; frontend normalization, scorer actions and RPC match SQL contracts');
} finally {
  await db.close();
}
