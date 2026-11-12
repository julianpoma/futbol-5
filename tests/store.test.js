import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { freshState, LEGACY_ID, ONSITE_ID } from '../src/state.js';
import CupStore from '../src/store.js';
import FakeDb, { MemoryStorage } from './helpers/fake-db.js';

async function setup() {
  const db = new FakeDb();
  const storage = new MemoryStorage();
  const store = new CupStore(db, storage);
  await store.start(LEGACY_ID);
  return { db, storage, store };
}

test('offline actions survive reload without changing legacy storage keys', async () => {
  const { db, storage, store } = await setup();
  storage.setItem('futbol5-pending-v1', '[{"a":"g"}]');
  storage.setItem('futbol5-cup-v1', '{"original":true}');
  db.offline = true;
  store.save({ matchId: 0, side: 'hs', type: 'goal' });
  await setImmediate();
  assert.equal(store.snapshot.queueLength, 1);
  assert.equal(store.snapshot.state.m[0].hs, 1);

  const reloaded = new CupStore(db, storage);
  await reloaded.start(LEGACY_ID);
  assert.equal(reloaded.snapshot.queueLength, 1);
  db.offline = false;
  await reloaded.sync();
  assert.equal(db.tournaments[0].state.m[0].hs, 1);
  assert.equal(reloaded.snapshot.queueLength, 0);
  assert.equal(storage.getItem('futbol5-pending-v1'), '[{"a":"g"}]');
  assert.equal(storage.getItem('futbol5-cup-v1'), '{"original":true}');
});

test('a committed write with a lost response is not counted twice', async () => {
  const { db, store } = await setup();
  db.loseResponse = true;
  store.save({ matchId: 0, side: 'hs', type: 'goal' });
  await setImmediate();
  assert.equal(store.snapshot.queueLength, 1);
  assert.equal(db.tournaments[0].state.m[0].hs, 1);
  await store.sync();
  assert.equal(store.snapshot.queueLength, 0);
  assert.equal(db.tournaments[0].state.m[0].hs, 1);
});

test('compare-and-swap conflicts rebase rather than overwrite scores', async () => {
  const { db, store } = await setup();
  db.conflict = true;
  db.tournaments[0].state.m[0].as = 2;
  store.save({ matchId: 0, side: 'hs', type: 'goal' });
  await setImmediate();
  assert.equal(store.snapshot.state.m[0].hs, 1);
  assert.equal(store.snapshot.state.m[0].as, 2);
  assert.equal(store.snapshot.queueLength, 0);
});

test('switching tournaments while a fetch runs never writes results to the new cup', async () => {
  const { db, store } = await setup();
  const otherId = '33333333-3333-4333-8333-333333333333';
  db.tournaments.push({ id: otherId, name: 'Another cup', onsite_id: ONSITE_ID, state: freshState(), version: 0 });
  await store.loadDirectory();
  let release;
  db.delayRead = () => new Promise(resolve => { release = resolve; });
  store.save({ matchId: 0, side: 'hs', type: 'goal' });
  await setImmediate();
  db.delayRead = null;
  await store.select(otherId);
  release();
  await setImmediate();
  assert.equal(store.snapshot.id, otherId);
  assert.equal(store.snapshot.state.m[0].hs, 0);
  assert.equal(db.tournaments[0].state.m[0].hs, 1);
  assert.equal(db.tournaments[1].state.m[0].hs, 0);
});

test('creation retry keeps its original ID even after a reload', async () => {
  const { db, storage, store } = await setup();
  const request = { id: crypto.randomUUID(), name: 'Fresh cup', onsiteId: ONSITE_ID, onsiteName: null, state: freshState() };
  db.loseResponse = true;
  await assert.rejects(store.createTournament(request));
  assert.equal(store.snapshot.pendingCreate.id, request.id);
  assert.equal(db.tournaments.length, 2);
  const reloaded = new CupStore(db, storage);
  await reloaded.start(LEGACY_ID);
  await reloaded.createTournament(reloaded.snapshot.pendingCreate);
  assert.equal(db.tournaments.length, 2);
  assert.equal(reloaded.snapshot.id, request.id);
  assert.equal(reloaded.snapshot.pendingCreate, null);
});

test('missing migration displays old results read-only instead of writing old schema', async () => {
  const db = new FakeDb();
  db.missingSchema = true;
  const store = new CupStore(db, new MemoryStorage());
  await store.start();
  assert.equal(store.snapshot.legacy, true);
  assert.equal(store.snapshot.state.m[0].hs, 0);
  store.save({ matchId: 0, side: 'hs', type: 'goal' });
  assert.equal(store.snapshot.queueLength, 0);
  assert.equal(store.snapshot.state.m[0].hs, 0);
  await assert.rejects(store.createTournament({}));
});
