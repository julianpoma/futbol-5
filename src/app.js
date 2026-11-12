import config from './config.js';
import { champion, finalists, freshState, goldenBoot, makeTeams, slotTime, standings } from './state.js';
import CupStore from './store.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// The store owns retries so failed saves become visible immediately.
const db = window.supabase?.createClient(config.url, config.key, { db: { retry: false, timeout: 10000 } }) || null;
const store = new CupStore(db);
let snapshot = store.snapshot;
let lastContent = '';
let lastDirectory = '';
let goalContext = null;
let toastTimer;
let creating = false;
let settingsCup = null;
let settingsInitial = {};

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function teamDot(index) {
  return `<span aria-hidden="true" class="team-dot team-${index}"></span>`;
}

function teamName(index) {
  return esc(snapshot.state.teams[index].name);
}

function command(type, matchId, extra = {}) {
  const entrants = matchId === 'final' ? finalists(snapshot.state)?.join(',') : undefined;
  store.save({ entrants, matchId, type, ...extra });
}

function renderDirectory() {
  const signature = JSON.stringify([snapshot.id, snapshot.onsites, snapshot.tournaments]);
  if (signature === lastDirectory) return;
  lastDirectory = signature;

  const tournament = snapshot.tournaments.find(item => item.id === snapshot.id);
  const onsiteId = tournament?.onsite_id || snapshot.onsites[0]?.id;
  $('onsite-picker').innerHTML = snapshot.onsites.map(onsite => `<option ${onsite.id === onsiteId ? 'selected' : ''} value="${esc(onsite.id)}">${esc(onsite.name)}</option>`).join('') || '<option>No onsites yet</option>';
  renderCupPicker(onsiteId);

  if (snapshot.id) {
    const url = new URL(location.href);
    url.searchParams.set('cup', snapshot.id);
    history.replaceState(null, '', url);
  }
}

function renderCupPicker(onsiteId) {
  const tournaments = snapshot.tournaments.filter(item => item.onsite_id === onsiteId);
  $('cup-picker').innerHTML = tournaments.map(item => `<option ${item.id === snapshot.id ? 'selected' : ''} value="${esc(item.id)}">${esc(item.name)}</option>`).join('') || '<option>No cups yet — create one!</option>';
  $('cup-picker').disabled = !tournaments.length;
}

function renderStandings(table) {
  const headers = ['#', 'Team', 'P', 'W', 'D', 'L', 'GD', 'Pts'];
  const rows = table.rows.map((row, rank) => `<tr class="${table.complete && !table.tied && rank < 2 ? 'qualified' : ''}">
    <td class="rank">${rank + 1}</td><td class="team-cell">${teamDot(row.i)}${teamName(row.i)}</td>
    <td>${row.p}</td><td>${row.w}</td><td>${row.d}</td><td>${row.l}</td><td>${row.gd > 0 ? '+' : ''}${row.gd}</td><td class="pts">${row.pts}</td></tr>`).join('');
  let tie = '';

  if (table.tied) {
    tie = `<div class="tie-box"><b>Too close to call.</b><p>Play a penalty shoot-out. Pick the tied teams from best to worst to decide the final places.</p><div class="btns">${table.tieTeams.map(index => `<button data-act="tie" data-team="${index}" ${snapshot.state.tb.includes(index) || snapshot.legacy ? 'disabled' : ''}>${teamName(index)}</button>`).join('')}<button data-act="clearTie" ${snapshot.legacy ? 'disabled' : ''}>Clear order</button></div></div>`;
  } else if (snapshot.state.tb.length) {
    tie = `<div class="tie-box">Final places decided by penalties. <button data-act="clearTie" ${snapshot.legacy ? 'disabled' : ''}>Clear order</button></div>`;
  }

  return `<section aria-labelledby="standings-heading" class="panel">
    <div class="panel-head"><h2 id="standings-heading"><span class="section-number">01</span> The table</h2><span class="muted">${table.played} / 6 played</span></div>
    <div class="table-wrap"><table aria-label="Tournament standings"><thead><tr>${headers.map((heading, index) => `<th class="${index === 1 ? 'team-cell' : ''}" scope="col">${heading}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="table-legend"><p>WIN 3 PTS · DRAW 1 · LOSS 0 · TOP 2 TO THE FINAL</p><p>Ties: goal difference → goals scored → penalty shoot-out</p></div>${tie}</section>`;
}

function scoreSide(match, matchId, teamIndex, side) {
  const locked = match.done || snapshot.legacy;
  return `<div class="side"><span class="name">${teamDot(teamIndex)}${teamName(teamIndex)}</span><span aria-label="${teamName(teamIndex)} score" class="num">${match[side]}</span>
    <div class="step"><button aria-label="Remove goal for ${teamName(teamIndex)}" data-act="manage" data-match="${matchId}" data-side="${side}" ${locked || !match[side] ? 'disabled' : ''}>−</button><button aria-label="Add goal for ${teamName(teamIndex)}" class="add" data-act="add" data-match="${matchId}" data-side="${side}" ${locked ? 'disabled' : ''}>+</button></div></div>`;
}

function timerControls(match, matchId) {
  if (match.done || snapshot.legacy) return '';
  const active = Boolean(match.endsAt);
  const started = active || match.remaining != null;
  const clock = active ? `data-end="${match.endsAt}"` : `data-remaining="${match.remaining || 0}"`;

  return `<div class="timer-bar">${started ? `<span class="timer-display">${active ? 'TIME LEFT' : 'PAUSED'} <strong ${clock}></strong></span>` : '<span class="timer-display">Ready when you are.</span>'}<button data-act="${active ? 'pause' : 'start'}" data-match="${matchId}">${active ? 'Pause' : started ? 'Resume' : '▶ Start match'}</button>${started ? `<button data-act="stop" data-match="${matchId}">Stop timer</button>` : ''}</div>`;
}

function matchFooter(match, matchId) {
  const tiedFinal = matchId === 'final' && match.hs === match.as && match.pen == null;
  return `<div class="match-foot"><button class="scorer-link" data-act="manage" data-match="${matchId}">${match.hs + match.as ? 'Goals & scorers' : 'No goals yet'}</button><button class="${match.done ? '' : 'button-primary'}" data-act="${match.done ? 'reopen' : 'done'}" data-match="${matchId}" ${snapshot.legacy || (!match.done && tiedFinal) ? 'disabled' : ''}>${match.done ? 'Reopen match' : 'Full time ✓'}</button></div>`;
}

function renderMatches() {
  const state = snapshot.state;
  const matches = state.order.map((id, slot) => {
    const match = state.m[id];
    const rest = [0, 1, 2].find(index => index !== match.h && index !== match.a);
    return `<article aria-label="Match ${slot + 1}: ${teamName(match.h)} versus ${teamName(match.a)}" class="match ${match.done ? 'done' : ''}" data-match-card="${id}">
      <div class="match-head"><span><b>MATCH ${String(slot + 1).padStart(2, '0')}</b><span class="match-meta"> · ${slotTime(state, slot)} · LEG ${id < 3 ? '1' : '2'}</span></span><span class="match-meta">${match.done ? '✓ FULL TIME' : match.endsAt ? '● ON THE PITCH' : 'UP NEXT'}</span></div>
      <div class="score">${scoreSide(match, id, match.h, 'hs')}<span class="vs">VS</span>${scoreSide(match, id, match.a, 'as')}</div>
      <p class="rest-note">On the sidelines: ${teamName(rest)}</p>${timerControls(match, id)}${matchFooter(match, id)}</article>`;
  }).join('');

  return `<section aria-labelledby="schedule-heading" class="stack"><div class="schedule-heading"><h2 id="schedule-heading">The matchday</h2><span class="muted">${state.dur} min games · ${state.gap} min breaks</span></div><div class="match-list">${matches}</div><p class="muted">Every pair plays twice. Then it’s all on the line in the final.</p></section>`;
}

function renderFinal(table) {
  const state = snapshot.state;
  const teams = finalists(state);
  let body;

  if (!teams) {
    body = `<div class="empty-final"><span aria-hidden="true" class="trophy">🏆</span><div><h3>Two spots. One trophy.</h3><p>${table.tied ? 'Settle the tie in the table to reveal your finalists.' : 'The top two teams meet here after all six group matches. Earn your place.'}</p></div></div>`;
  } else {
    const match = state.fin;
    body = `<div class="score">${scoreSide(match, 'final', teams[0], 'hs')}<span class="vs">VS</span>${scoreSide(match, 'final', teams[1], 'as')}</div>`;
    if (match.hs === match.as) {
      body += `<div class="penalty-box">Level at the whistle? Choose the penalty shoot-out winner.<div class="btns">${teams.map(index => `<button class="${match.pen === index ? 'selected' : ''}" data-act="pen" data-match="final" data-team="${index}" ${match.done || snapshot.legacy ? 'disabled' : ''}>${teamName(index)}</button>`).join('')}</div></div>`;
    }

    body += timerControls(match, 'final') + matchFooter(match, 'final');
    const winner = champion(state);
    if (winner != null) {
      body += `<div class="champion"><p class="eyebrow">🏆 YOUR DOUBLE CUP CHAMPIONS</p><h3>${teamName(winner)}</h3><p>The trophy is yours. So is the group chat.</p></div>`;
    }
  }

  return `<section aria-labelledby="final-heading" class="panel final-panel"><div class="panel-head"><h2 id="final-heading"><span class="section-number">02</span> The grand final</h2><span class="final-badge">${slotTime(state, 6)} · WINNER TAKES ALL</span></div><div class="final-content">${body}</div></section>`;
}

function renderGoldenBoot() {
  const players = goldenBoot(snapshot.state);
  const list = players.length ? `<ol class="boot-list">${players.map((player, rank) => `<li><span class="rank">${String(rank + 1).padStart(2, '0')}</span><div class="player-info"><b>${esc(player.name)}</b><small>${teamDot(player.team)}${teamName(player.team)}</small></div><span aria-label="${player.goals} goals" class="goals-total">${player.goals}</span></li>`).join('')}</ol>` : '<div class="boot-empty">The Golden Boot is up for grabs.<br>Pick a scorer when adding a goal to get on the board.</div>';
  const unknown = [...snapshot.state.m, snapshot.state.fin].flatMap(match => match.goals).filter(goal => !goal.playerId).length;

  return `<section aria-labelledby="boot-heading" class="panel"><div class="panel-head"><h2 id="boot-heading"><span class="section-number">03</span> Golden Boot</h2><span aria-hidden="true">👟</span></div>${list}<p class="panel-note">${unknown ? `${unknown} goal${unknown === 1 ? '' : 's'} without a scorer. ` : ''}Group + final goals. Shoot-outs don’t count.</p></section>`;
}

function renderSquads() {
  return `<section aria-labelledby="squads-heading" class="panel"><div class="panel-head"><h2 id="squads-heading"><span class="section-number">04</span> The squads</h2><span class="muted">Meet the competition</span></div><div class="squad-grid">${snapshot.state.teams.map((team, index) => `<div class="squad team-${index}"><h3>${esc(team.name)}</h3><ul>${team.players.map(player => `<li>${esc(player.name)}${player.captain ? '<span aria-label="Captain" class="cap">C</span>' : ''}</li>`).join('')}</ul></div>`).join('')}</div></section>`;
}

function render(snapshotUpdate) {
  snapshot = snapshotUpdate;
  $('sync').textContent = snapshot.status;
  $('sync').className = `sync-chip ${snapshot.status.startsWith('Live') ? 'is-live' : 'is-offline'}`;
  $('notice').hidden = !snapshot.message;
  $('notice').textContent = snapshot.message;
  $('storage-notice').hidden = !snapshot.storageError;
  $('legacy-notice').hidden = !snapshot.pendingLegacy;
  $('creation-notice').hidden = !snapshot.pendingCreate;
  $('new-cup').disabled = snapshot.legacy || !db || creating;
  renderDirectory();

  const signature = JSON.stringify([snapshot.id, snapshot.state, snapshot.legacy]);
  if (signature === lastContent) return;
  lastContent = signature;

  if (!snapshot.state) {
    $('content').innerHTML = '<div class="empty-state"><span aria-hidden="true" class="empty-icon">⚽</span><h2>Waiting for kick-off.</h2><p>Select a tournament, create a new one, or check your connection.</p><button data-act="refresh" style="margin-top:16px">Retry connection</button></div>';
    return;
  }

  const table = standings(snapshot.state);
  const tournament = snapshot.tournaments.find(item => item.id === snapshot.id);
  const active = document.activeElement?.closest('button[data-act]');
  const focus = active && $('content').contains(active) ? { act: active.dataset.act, match: active.dataset.match, side: active.dataset.side } : null;
  const status = snapshot.state.fin.done ? '🏆 CUP COMPLETE' : table.played ? '● GAME ON' : 'READY TO KICK OFF';
  $('content').innerHTML = `<div class="section-intro"><div><p class="eyebrow">${status}</p><h2>${esc(tournament?.name || 'Matchday')}</h2></div><button data-act="settings" ${snapshot.legacy ? 'disabled' : ''}>Matchday settings ↗</button></div><div class="cols"><div class="stack">${renderStandings(table)}${renderFinal(table)}${renderGoldenBoot()}${renderSquads()}</div>${renderMatches()}</div>`;
  updateTimers();

  if (focus) {
    const replacement = [...$('content').querySelectorAll('button[data-act]')].find(button => button.dataset.act === focus.act && button.dataset.match === focus.match && button.dataset.side === focus.side);
    replacement?.focus({ preventScroll: true });
  }

  if ($('goal-dialog').open && goalContext && goalContext.cupId !== snapshot.id) $('goal-dialog').close();
  if ($('settings-dialog').open && settingsCup !== snapshot.id) $('settings-dialog').close();
}

function updateTimers() {
  document.querySelectorAll('[data-end], [data-remaining]').forEach(element => {
    const ms = element.dataset.end ? Number(element.dataset.end) - Date.now() : Number(element.dataset.remaining);
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    element.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });
}

function contextMatch() {
  if (!goalContext || goalContext.cupId !== snapshot.id) return null;
  if (goalContext.matchId === 'final' && goalContext.entrants !== finalists(snapshot.state)?.join(',')) return null;
  return goalContext.matchId === 'final' ? snapshot.state.fin : snapshot.state.m[goalContext.matchId];
}

function contextTeam(side) {
  const match = contextMatch();
  return goalContext.matchId === 'final' ? finalists(snapshot.state)[side === 'hs' ? 0 : 1] : match[side === 'hs' ? 'h' : 'a'];
}

function playerOptions(teamIndex, selected) {
  return `<option ${!selected ? 'selected' : ''} value="">Unknown scorer</option>${snapshot.state.teams[teamIndex].players.map(player => `<option ${player.id === selected ? 'selected' : ''} value="${esc(player.id)}">${esc(player.name)}${player.captain ? ' (C)' : ''}</option>`).join('')}`;
}

function renderGoalDialog() {
  const match = contextMatch();
  if (!match) { $('goal-dialog').close(); return; }

  $('goal-title').textContent = goalContext.mode === 'add' ? 'Who scored?' : 'Goals & scorers';
  $('goal-eyebrow').textContent = goalContext.mode === 'add' ? 'GET IN!' : 'GIVE CREDIT WHERE IT’S DUE';
  if (goalContext.mode === 'add') {
    if (match.done || snapshot.legacy) { $('goal-dialog').close(); return; }
    const teamIndex = contextTeam(goalContext.side);
    $('goal-body').innerHTML = `<p class="goal-context">A goal for <b>${teamName(teamIndex)}</b>. Make it count.</p><form id="add-goal-form"><label for="scorer-picker">Goalscorer<select id="scorer-picker" name="playerId">${playerOptions(teamIndex, null)}</select></label><div class="dialog-actions"><button data-close="goal-dialog" type="button">Cancel</button><button class="button-primary" type="submit">GOOOAL! +1 ⚽</button></div></form>`;
  } else {
    const goals = match.goals.filter(goal => !goalContext.side || goal.side === goalContext.side);
    $('goal-body').innerHTML = `<p class="goal-context">${snapshot.legacy ? 'Historical goals have no recorded scorers.' : 'Correct a scorer without changing the score. Reopen a finished match to remove a goal.'}</p>${goals.length ? goals.map((goal, index) => `<div class="goal-record"><label for="scorer-${index}">${teamName(contextTeam(goal.side))} · GOAL ${index + 1}<select data-goal-id="${esc(goal.id)}" id="scorer-${index}" ${snapshot.legacy ? 'disabled' : ''}>${playerOptions(contextTeam(goal.side), goal.playerId)}</select></label><button aria-label="Remove goal ${index + 1}" class="danger" data-remove-goal="${esc(goal.id)}" ${match.done || snapshot.legacy ? 'disabled' : ''}>Remove</button></div>`).join('') : '<p class="muted">No goals recorded yet. The net is waiting.</p>'}<div class="dialog-actions"><button data-close="goal-dialog" type="button">Done</button></div>`;
  }
}

function openGoals(matchId, mode, side) {
  goalContext = { cupId: snapshot.id, entrants: matchId === 'final' ? finalists(snapshot.state)?.join(',') : null, matchId, mode, side };
  renderGoalDialog();
  $('goal-dialog').showModal();
}

function openCreate() {
  if (snapshot.pendingCreate) {
    toast('Finish the saved creation request first. Use Retry creation above.');
    return;
  }
  $('create-form').reset();
  $('create-onsite').innerHTML = snapshot.onsites.map(onsite => `<option ${onsite.id === $('onsite-picker').value ? 'selected' : ''} value="${esc(onsite.id)}">${esc(onsite.name)}</option>`).join('') + '<option value="new">＋ Add a new onsite</option>';
  updateNewOnsite();
  $('team-forms').innerHTML = [0, 1, 2].map(index => `<div class="team-form team-${index}"><label>Team ${index + 1} name<input maxlength="60" name="team${index}" placeholder="Give your team a name" required></label><label>Players<textarea maxlength="1000" name="players${index}" placeholder="Alex*&#10;Sam&#10;Jordan&#10;Taylor&#10;Casey" required rows="5"></textarea></label><p class="muted">One player per line, or comma-separated. Add * for the captain. 1–15 players.</p></div>`).join('');
  $('create-error').hidden = true;
  $('create-dialog').showModal();
}

function updateNewOnsite() {
  const isNew = $('create-onsite').value === 'new';
  $('new-onsite-label').hidden = !isNew;
  const input = $('create-form').elements.newOnsite;
  input.disabled = !isNew;
  input.required = isNew;
}

function createPayload(form) {
  const data = new FormData(form);
  const names = [];
  const rosters = [];

  for (let index = 0; index < 3; index++) {
    const name = data.get(`team${index}`).trim();
    const players = data.get(`players${index}`).split(/[,\n]/).map(item => item.trim()).filter(Boolean);
    if (!name || name.length > 60) throw new Error('Give each team a name of 1–60 characters.');
    if (!players.length || players.length > 15) throw new Error(`Team ${index + 1} needs 1–15 players.`);
    if (players.some(player => !player.replace(/\*$/, '').trim() || player.length > 60)) throw new Error('Player names must contain 1–60 characters.');
    if (new Set(players.map(player => player.replace(/\*$/, '').toLowerCase())).size !== players.length) throw new Error(`Team ${index + 1} has duplicate player names.`);
    names.push(name);
    rosters.push(players);
  }

  if (new Set(names.map(name => name.toLowerCase())).size !== 3) throw new Error('Each team needs a different name.');
  const name = data.get('name').trim();
  const onsiteName = data.get('onsite') === 'new' ? data.get('newOnsite').trim() : null;
  if (!name || (onsiteName !== null && !onsiteName)) throw new Error('Enter a tournament name and an onsite name.');
  const state = freshState(makeTeams(names, rosters));
  state.start = data.get('start');
  state.dur = Number(data.get('dur'));
  state.gap = Number(data.get('gap'));

  return { id: crypto.randomUUID(), name, onsiteId: onsiteName ? crypto.randomUUID() : data.get('onsite'), onsiteName, state };
}

async function submitCreation(payload) {
  if (creating) return;
  creating = true;
  $('create-submit').disabled = true;
  $('retry-create').disabled = true;
  $('new-cup').disabled = true;
  try {
    await store.createTournament(payload);
    $('create-dialog').close();
    toast('A new cup is born. Let the trash talk begin.');
  } catch (error) {
    const message = snapshot.storageError
      ? 'Enable browser storage before creating a cup. No new creation request was sent.'
      : 'Could not create the cup. Your request is saved — retry it without creating a duplicate.';
    $('create-error').textContent = message;
    $('create-error').hidden = false;
    toast(message);
    console.warn('Tournament creation failed:', error.message || 'Connection error');
  } finally {
    creating = false;
    $('create-submit').disabled = false;
    $('retry-create').disabled = false;
    $('new-cup').disabled = snapshot.legacy || !db;
  }
}

$('new-cup').addEventListener('click', openCreate);
$('create-onsite').addEventListener('change', updateNewOnsite);
$('create-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if (snapshot.pendingCreate) { void submitCreation(snapshot.pendingCreate); return; }
    const payload = createPayload(event.target);
    $('create-error').hidden = true;
    void submitCreation(payload);
  } catch (error) {
    $('create-error').textContent = error.message;
    $('create-error').hidden = false;
  }
});
$('retry-create').addEventListener('click', () => void submitCreation(snapshot.pendingCreate));
$('onsite-picker').addEventListener('change', event => {
  renderCupPicker(event.target.value);
  const first = snapshot.tournaments.find(item => item.onsite_id === event.target.value);
  if (first) void store.select(first.id);
});
$('cup-picker').addEventListener('change', event => void store.select(event.target.value));

document.addEventListener('click', event => {
  const closer = event.target.closest('[data-close]');
  if (closer) { $(closer.dataset.close).close(); return; }

  const button = event.target.closest('button[data-act]');
  if (!button || button.disabled) return;
  const type = button.dataset.act;
  const matchId = button.dataset.match === 'final' ? 'final' : Number(button.dataset.match);

  if (type === 'refresh') { void store.start(snapshot.id); return; }
  if (type === 'add' || type === 'manage') { openGoals(matchId, type, button.dataset.side); return; }
  if (type === 'settings') {
    settingsCup = snapshot.id;
    settingsInitial = {};
    for (const key of ['start', 'dur', 'gap']) {
      settingsInitial[key] = String(snapshot.state[key]);
      $('settings-form').elements[key].value = settingsInitial[key];
    }
    $('settings-dialog').showModal();
    return;
  }

  if (type === 'reopen' && matchId !== 'final' && (snapshot.state.fin.done || snapshot.state.fin.hs || snapshot.state.fin.as || snapshot.state.fin.endsAt || snapshot.state.fin.pen != null)) {
    if (!confirm('Reopening a group match clears the final result and its scorers, because the finalists may change. Continue?')) return;
  }
  if (type === 'clearTie' && !confirm('Clear the penalty order? This also clears any final result and final scorers.')) return;
  command(type, matchId, { at: Date.now(), team: Number(button.dataset.team) });
});

$('goal-body').addEventListener('submit', event => {
  if (event.target.id !== 'add-goal-form') return;
  event.preventDefault();
  const match = contextMatch();
  if (!match || match.done) { $('goal-dialog').close(); toast('This match changed. Please try again.'); return; }
  command('goal', goalContext.matchId, { playerId: new FormData(event.target).get('playerId') || null, side: goalContext.side });
  $('goal-dialog').close();
  toast('GOOOAL! ⚽');
});
$('goal-body').addEventListener('change', event => {
  if (!event.target.dataset.goalId || !contextMatch()) return;
  command('scorer', goalContext.matchId, { goalId: event.target.dataset.goalId, playerId: event.target.value || null });
  toast('Scorer updated. Credit where it’s due.');
});
$('goal-body').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-goal]');
  if (!button || button.disabled || !contextMatch()) return;
  command('removeGoal', goalContext.matchId, { goalId: button.dataset.removeGoal });
  renderGoalDialog();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (settingsCup !== snapshot.id) return;
  const data = new FormData(event.target);
  for (const key of ['start', 'dur', 'gap']) {
    if (data.get(key) !== settingsInitial[key]) command('setting', undefined, { key, value: data.get(key) });
  }
  $('settings-dialog').close();
  toast('Matchday settings saved.');
});

store.subscribe(render);
render(store.snapshot);
void store.start(new URL(location.href).searchParams.get('cup'));
setInterval(updateTimers, 1000);
setInterval(() => void store.syncPending(), 5000);
setInterval(() => { void store.loadDirectory().catch(() => {}); }, 30000);
window.addEventListener('online', () => { void store.start(snapshot.id); });
window.addEventListener('focus', () => void store.syncPending());
window.addEventListener('beforeunload', event => {
  if (store.snapshot.storageError && store.snapshot.totalPending) {
    event.preventDefault();
    event.returnValue = '';
  }
});
