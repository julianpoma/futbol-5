import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyAction, champion, finalists, freshState, goldenBoot, normalizeState, slotTime, standings } from '../src/state.js';

const legacy = JSON.parse(await readFile(new URL('./fixtures/legacy.json', import.meta.url)));
let sequence = 0;
const act = (state, action) => applyAction(state, { opId: `op-${++sequence}`, ...action });

function completeGroups() {
  let state = freshState();
  state.m[0].hs = 1;
  state.m[1].hs = 1;
  state.m[2].as = 1;
  state.m[3].as = 1;
  state.m[4].hs = 1;
  state.m[5].hs = 1;
  state.m.forEach(match => { match.done = true; });
  return normalizeState(state);
}

test('legacy normalization preserves all scores, settings and champion', () => {
  const input = structuredClone(legacy.state);
  const state = normalizeState(input);
  for (const key of ['dur', 'gap', 'start', 'order', 'names', 'tb']) assert.deepEqual(state[key], input[key]);
  state.m.forEach((match, index) => {
    const { goals, ...original } = match;
    assert.deepEqual(original, input.m[index]);
    assert.equal(goals.length, match.hs + match.as);
    assert.ok(goals.every(goal => goal.playerId === null));
  });
  assert.equal(state.fin.hs, 2);
  assert.equal(state.fin.as, 4);
  assert.deepEqual(finalists(state), [0, 2]);
  assert.equal(champion(state), 2);
  assert.equal(state.teams[champion(state)].name, 'Manchester Unreconciled');
  assert.equal(state.m.flatMap(match => match.goals).length + state.fin.goals.length, 32);
  assert.deepEqual(goldenBoot(state), []);
  assert.deepEqual(input, legacy.state);
});

test('new cups have independent teams, scores, settings and goals', () => {
  const first = freshState();
  const second = freshState();
  first.teams[0].name = 'Different';
  first.m[0].hs = 3;
  assert.notEqual(second.teams[0].name, 'Different');
  assert.equal(second.m[0].hs, 0);
  assert.equal(second.m[0].goals.length, 0);
});

test('goals record only players on the scoring team', () => {
  const initial = freshState();
  const playerId = initial.teams[0].players[0].id;
  let state = act(initial, { matchId: 0, playerId, side: 'hs', type: 'goal' });
  assert.equal(state.m[0].hs, 1);
  assert.equal(state.m[0].goals[0].playerId, playerId);
  assert.equal(goldenBoot(state)[0].goals, 1);
  assert.equal(initial.m[0].hs, 0);
  state = act(state, { matchId: 0, playerId, side: 'as', type: 'goal' });
  assert.equal(state.m[0].as, 1);
  assert.equal(state.m[0].goals.find(goal => goal.side === 'as').playerId, null);
});

test('unknown goals do not count toward Golden Boot; correcting a scorer never changes scores', () => {
  let state = act(freshState(), { matchId: 0, playerId: null, side: 'hs', type: 'goal' });
  assert.equal(goldenBoot(state).length, 0);
  const goalId = state.m[0].goals[0].id;
  const playerId = state.teams[0].players[1].id;
  state = act(state, { goalId, matchId: 0, playerId, type: 'scorer' });
  assert.equal(goldenBoot(state)[0].name, 'Facu B');
  assert.equal(state.m[0].hs, 1);
  state = act(state, { goalId, matchId: 0, type: 'removeGoal' });
  assert.equal(state.m[0].hs, 0);
  assert.equal(goldenBoot(state).length, 0);
});

test('replaying a save after an ambiguous network response is idempotent', () => {
  const action = { opId: 'same-operation', matchId: 0, side: 'hs', type: 'goal' };
  const state = applyAction(applyAction(freshState(), action), action);
  assert.equal(state.m[0].hs, 1);
  assert.equal(state.m[0].goals.length, 1);
  assert.equal(state.applied.length, 1);
});

test('two users removing the same goal cannot remove a different goal', () => {
  let state = act(freshState(), { matchId: 0, side: 'hs', type: 'goal' });
  state = act(state, { matchId: 0, side: 'hs', type: 'goal' });
  const goalId = state.m[0].goals[0].id;
  state = act(state, { goalId, matchId: 0, type: 'removeGoal' });
  state = act(state, { goalId, matchId: 0, type: 'removeGoal' });
  assert.equal(state.m[0].hs, 1);
});

test('finished matches reject score edits but allow historical scorer assignment', () => {
  let state = normalizeState(legacy.state);
  const playerId = state.teams[0].players[0].id;
  state = act(state, { matchId: 0, playerId, side: 'hs', type: 'goal' });
  assert.equal(state.m[0].hs, 3);
  state = act(state, { goalId: state.m[0].goals[0].id, matchId: 0, playerId, type: 'scorer' });
  assert.equal(state.m[0].hs, 3);
  assert.equal(goldenBoot(state)[0].goals, 1);
});

test('group standings and three-way penalties determine finalists', () => {
  let state = freshState();
  assert.equal(finalists(state), null);
  state.m.forEach(match => { match.done = true; });
  assert.equal(standings(state).tied, true);
  assert.equal(finalists(state), null);
  state = act(state, { team: 2, type: 'tie' });
  assert.equal(finalists(state), null);
  state = act(state, { team: 0, type: 'tie' });
  assert.deepEqual(finalists(state), [2, 0]);
});

test('final goals count but shoot-outs do not; tied final needs a penalty winner', () => {
  let state = completeGroups();
  const entrants = finalists(state).join(',');
  const playerId = state.teams[0].players[0].id;
  state = act(state, { entrants, matchId: 'final', type: 'done' });
  assert.equal(state.fin.done, false);
  state = act(state, { entrants, matchId: 'final', playerId, side: 'hs', type: 'goal' });
  state = act(state, { entrants, matchId: 'final', side: 'as', type: 'goal' });
  state = act(state, { entrants, matchId: 'final', team: 0, type: 'pen' });
  state = act(state, { entrants, matchId: 'final', type: 'done' });
  assert.equal(champion(state), 0);
  assert.equal(goldenBoot(state)[0].goals, 1);
});

test('stale final actions never replay onto different finalists', () => {
  let state = completeGroups();
  state = act(state, { entrants: '1,2', matchId: 'final', side: 'hs', type: 'goal' });
  assert.equal(state.fin.hs, 0);
});

test('reopening a group resets only its tournament final, including scorers and timers', () => {
  let state = normalizeState(legacy.state);
  state = act(state, { matchId: 0, type: 'reopen' });
  assert.equal(state.m[0].done, false);
  assert.equal(state.m[0].hs, 3);
  assert.equal(state.fin.hs, 0);
  assert.equal(state.fin.goals.length, 0);
  assert.equal(state.fin.done, false);
});

test('shared timers pause, resume and stop using action timestamps', () => {
  let state = act(freshState(), { at: 1000, matchId: 0, type: 'start' });
  assert.equal(state.m[0].endsAt, 781000);
  state = act(state, { at: 11000, matchId: 0, type: 'pause' });
  assert.equal(state.m[0].remaining, 770000);
  state = act(state, { at: 30000, matchId: 0, type: 'start' });
  assert.equal(state.m[0].endsAt, 800000);
  state = act(state, { matchId: 0, type: 'stop' });
  assert.equal(state.m[0].endsAt, null);
  assert.equal(state.m[0].remaining, null);
});

test('kick-off slots wrap at midnight and settings enforce limits', () => {
  let state = freshState();
  state = act(state, { key: 'start', type: 'setting', value: '23:55' });
  assert.equal(slotTime(state, 1), '00:10');
  state = act(state, { key: 'start', type: 'setting', value: '25:00' });
  assert.equal(state.start, '23:55');
  state = act(state, { key: 'dur', type: 'setting', value: -5 });
  assert.equal(state.dur, 1);
});
