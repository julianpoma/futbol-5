export const LEGACY_ID = '22222222-2222-4222-8222-222222222222';
export const ONSITE_ID = '11111111-1111-4111-8111-111111111111';

const FIXTURES = [[0, 1], [2, 0], [1, 2], [1, 0], [0, 2], [2, 1]];
const TEAM_NAMES = ["Julian's Old Boys", 'La Triple Alianza', 'Manchester Unreconciled'];
const ROSTERS = [
  ['Julian*', 'Facu B', 'Fabri', 'Okt', 'Marin'],
  ['Fernanda*', 'Uri', 'Luca', 'Facu M', 'Mati'],
  ['Kenny*', 'Tincho', 'Ivan', 'Melissa', 'Ez'],
];

export function makeTeams(names = TEAM_NAMES, rosters = ROSTERS) {
  return names.map((name, index) => ({
    id: `team-${index}`,
    name,
    players: rosters[index].map((player, slot) => ({
      id: `team-${index}-player-${slot}`,
      captain: player.endsWith('*'),
      name: player.replace(/\*$/, ''),
    })),
  }));
}

export function emptyFinal() {
  return { as: 0, done: false, endsAt: null, goals: [], hs: 0, pen: null, remaining: null };
}

export function freshState(teams = makeTeams()) {
  return {
    applied: [],
    dur: 13,
    fin: emptyFinal(),
    gap: 2,
    m: FIXTURES.map(([h, a]) => ({ a, as: 0, done: false, goals: [], h, hs: 0 })),
    order: [0, 1, 2, 3, 4, 5],
    start: '18:00',
    tb: [],
    teams: structuredClone(teams),
  };
}

function normalizeGoals(match, id) {
  const existing = Array.isArray(match.goals) ? match.goals : [];
  match.goals = ['hs', 'as'].flatMap(side => {
    const goals = existing.filter(goal => goal.side === side).slice(0, match[side]);

    while (goals.length < match[side]) {
      goals.push({ id: `legacy-${id}-${side}-${goals.length}`, playerId: null, side });
    }

    return goals;
  });

  return match;
}

export function normalizeState(input) {
  const state = { ...freshState(), ...structuredClone(input || {}) };
  state.m = state.m.map((match, index) => normalizeGoals(match, index));
  state.fin = normalizeGoals(state.fin, 'final');
  state.applied ||= [];

  return state;
}

function rankingEqual(left, right) {
  return left.pts === right.pts && left.gd === right.gd && left.gf === right.gf;
}

export function standings(state) {
  const rows = state.teams.map((team, i) => ({ i, d: 0, ga: 0, gf: 0, l: 0, p: 0, w: 0 }));
  let played = 0;

  for (const match of state.m) {
    if (!match.done) continue;

    played++;
    const home = rows[match.h];
    const away = rows[match.a];
    home.p++;
    away.p++;
    home.gf += match.hs;
    home.ga += match.as;
    away.gf += match.as;
    away.ga += match.hs;

    if (match.hs > match.as) { home.w++; away.l++; }
    else if (match.hs < match.as) { away.w++; home.l++; }
    else { home.d++; away.d++; }
  }

  for (const row of rows) {
    row.gd = row.gf - row.ga;
    row.pts = row.w * 3 + row.d;
    const index = state.tb.indexOf(row.i);
    row.tb = index < 0 ? Infinity : index;
  }

  rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.tb - b.tb || a.i - b.i);
  const complete = played === state.m.length;
  const tied = complete && rankingEqual(rows[1], rows[2]) && rows[1].tb === rows[2].tb;
  const tieTeams = tied ? rows.filter(row => rankingEqual(row, rows[1])).map(row => row.i) : [];

  return { complete, played, rows, tieTeams, tied };
}

export function finalists(state) {
  const table = standings(state);
  return table.complete && !table.tied ? table.rows.slice(0, 2).map(row => row.i) : null;
}

export function champion(state) {
  const teams = finalists(state);
  if (!teams || !state.fin.done) return null;

  const match = state.fin;
  return match.hs > match.as ? teams[0] : match.hs < match.as ? teams[1] : match.pen;
}

export function goldenBoot(state) {
  const totals = new Map();
  const teams = finalists(state);
  const matches = [...state.m, ...(teams ? [{ ...state.fin, a: teams[1], h: teams[0] }] : [])];

  for (const match of matches) {
    for (const goal of match.goals) {
      const teamIndex = goal.side === 'hs' ? match.h : match.a;
      const player = state.teams[teamIndex].players.find(item => item.id === goal.playerId);
      if (!player) continue;

      const entry = totals.get(player.id) || { id: player.id, goals: 0, name: player.name, team: teamIndex };
      entry.goals++;
      totals.set(player.id, entry);
    }
  }

  return [...totals.values()].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name));
}

function changeTimer(match, action, duration) {
  if (match.done) return;

  if (action.type === 'start' && !match.endsAt) {
    match.endsAt = action.at + (match.remaining ?? duration * 60000);
    match.remaining = null;
  } else if (action.type === 'pause' && match.endsAt) {
    match.remaining = Math.max(0, match.endsAt - action.at);
    match.endsAt = null;
  } else if (action.type === 'stop') {
    match.endsAt = null;
    match.remaining = null;
  }
}

export function applyAction(input, action) {
  const state = normalizeState(input);
  if (!action.opId || state.applied.includes(action.opId)) return state;

  state.applied.push(action.opId);
  const final = action.matchId === 'final';
  const match = final ? state.fin : state.m[action.matchId];
  const qualified = final ? finalists(state) : null;

  // Never replay a stale final edit onto a different pair of finalists.
  if (final && (!qualified || action.entrants !== qualified.join(','))) return state;

  if (action.type === 'goal' && match && !match.done && ['hs', 'as'].includes(action.side)) {
    const teamIndex = final ? qualified[action.side === 'hs' ? 0 : 1] : match[action.side === 'hs' ? 'h' : 'a'];
    const playerId = state.teams[teamIndex].players.some(player => player.id === action.playerId) ? action.playerId : null;
    match.goals.push({ id: action.opId, playerId, side: action.side });
    match[action.side]++;
    if (final) match.pen = null;
  } else if (action.type === 'removeGoal' && match && !match.done) {
    const goal = match.goals.find(item => item.id === action.goalId);
    if (goal) {
      match[goal.side]--;
      match.goals = match.goals.filter(item => item.id !== action.goalId);
      if (final) match.pen = null;
    }
  } else if (action.type === 'scorer' && match) {
    const goal = match.goals.find(item => item.id === action.goalId);
    if (goal) {
      const teamIndex = final ? qualified[goal.side === 'hs' ? 0 : 1] : match[goal.side === 'hs' ? 'h' : 'a'];
      goal.playerId = state.teams[teamIndex].players.some(player => player.id === action.playerId) ? action.playerId : null;
    }
  } else if (['start', 'pause', 'stop'].includes(action.type) && match) {
    changeTimer(match, action, state.dur);
  } else if (action.type === 'done' && match) {
    if (final && match.hs === match.as && !qualified.includes(match.pen)) return state;
    match.done = true;
    match.endsAt = null;
    match.remaining = null;
  } else if (action.type === 'reopen' && match) {
    match.done = false;
    if (!final) {
      state.fin = emptyFinal();
      state.tb = [];
    }
  } else if (action.type === 'pen' && final && !match.done && qualified.includes(action.team)) {
    match.pen = action.team;
  } else if (action.type === 'tie' && !state.fin.done && standings(state).tieTeams.includes(action.team)) {
    if (!state.tb.includes(action.team)) state.tb.push(action.team);
  } else if (action.type === 'clearTie') {
    state.tb = [];
    state.fin = emptyFinal();
  } else if (action.type === 'setting') {
    if (action.key === 'start' && /^([01]\d|2[0-3]):[0-5]\d$/.test(action.value)) state.start = action.value;
    if (action.key === 'dur') state.dur = Math.max(1, Math.min(90, Number(action.value) || 13));
    if (action.key === 'gap') state.gap = Math.max(0, Math.min(30, Number(action.value) || 0));
  }

  return state;
}

export function slotTime(state, index) {
  const [hours, minutes] = state.start.split(':').map(Number);
  const total = (hours * 60 + minutes + index * (state.dur + state.gap)) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
