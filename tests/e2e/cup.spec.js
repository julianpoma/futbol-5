import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { freshState, LEGACY_ID, makeTeams, normalizeState, ONSITE_ID } from '../../src/state.js';

const legacy = JSON.parse(await readFile(new URL('../fixtures/legacy.json', import.meta.url)));
const sdkPath = new URL('../../node_modules/@supabase/supabase-js/dist/umd/supabase.js', import.meta.url).pathname;
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

async function mockBackend(context, { missingSchema = false } = {}) {
  const backend = {
    offline: false,
    onsites: [{ id: ONSITE_ID, name: 'Buenos Aires · Nov 2026' }],
    tournaments: [
      { id: LEGACY_ID, legacy_source_id: 1, name: 'Buenos Aires Nov 26 Cup', onsite_id: ONSITE_ID, state: { ...legacy.state, teams: makeTeams() }, version: 84 },
      { id: OTHER_ID, name: 'Hackathon Kickabout', onsite_id: ONSITE_ID, state: freshState(), version: 0 },
    ],
  };
  await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ contentType: 'application/javascript', path: sdkPath }));
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '', contentType: 'text/css' }));
  await context.routeWebSocket(/supabase\.co/, socket => socket.close());
  await context.route('https://*.supabase.co/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split('/').pop();
    const respond = (data, status = 200) => route.fulfill({ body: JSON.stringify(data), contentType: 'application/json', status });
    if (backend.offline) return route.abort('internetdisconnected');
    if (missingSchema && table !== 'tournament_state') return respond({ code: 'PGRST205', message: 'Missing relation' }, 404);
    if (table === 'tournament_state') return respond({ state: legacy.state, version: legacy.version });
    if (table === 'create_cup_tournament') {
      const args = request.postDataJSON();
      if (!backend.tournaments.some(item => item.id === args.p_id)) {
        let onsite = args.p_onsite_name ? backend.onsites.find(item => item.name.toLowerCase() === args.p_onsite_name.toLowerCase()) : backend.onsites.find(item => item.id === args.p_onsite_id);
        if (!onsite) {
          onsite = { id: args.p_onsite_id, name: args.p_onsite_name };
          backend.onsites.push(onsite);
        }
        backend.tournaments.push({ id: args.p_id, name: args.p_name, onsite_id: onsite.id, state: args.p_state, version: 0 });
      }
      return respond(args.p_id);
    }
    const collection = table === 'cup_onsites' ? backend.onsites : backend.tournaments;
    const rows = collection.filter(row => [...url.searchParams].every(([key, value]) => !value.startsWith('eq.') || String(row[key]) === value.slice(3)));
    if (request.method() === 'PATCH') rows.forEach(row => Object.assign(row, request.postDataJSON()));
    return respond(request.headers().accept?.includes('vnd.pgrst.object') ? rows[0] : rows);
  });
  return backend;
}

async function openFresh(page) {
  await page.goto(`/?cup=${OTHER_ID}`);
  await expect(page.getByRole('heading', { exact: true, name: 'Hackathon Kickabout' })).toBeVisible();
}

async function addGoal(page, card, side, player) {
  await card.getByRole('button', { name: `Add goal for ${side}` }).click();
  await page.getByRole('combobox', { name: 'Goalscorer' }).selectOption(player || '');
  await page.getByRole('button', { name: 'GOOOAL! +1' }).click();
  await expect(page.locator('#goal-dialog')).not.toBeVisible();
}

test('archive keeps every result and champion, with honest unknown scorers', async ({ context, page }, testInfo) => {
  const backend = await mockBackend(context);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/?cup=${LEGACY_ID}`);
  await expect(page).toHaveTitle('Double Futbol 5 Cup');
  await expect(page.locator('.champion')).toContainText('Manchester Unreconciled');
  await expect(page.locator('.match.done')).toHaveCount(6);
  await expect(page.getByText('32 goals without a scorer.', { exact: false })).toBeVisible();
  await expect(page.locator('[data-match-card="0"] .num')).toHaveText(['3', '2']);
  expect(backend.tournaments[0].state).toEqual({ ...legacy.state, teams: makeTeams() });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath('archive.png') });
  expect(errors).toEqual([]);
});

test('picker records scorers; corrections and goal removal keep totals consistent', async ({ context, page }) => {
  const backend = await mockBackend(context);
  await openFresh(page);
  const card = page.locator('[data-match-card="0"]');
  await addGoal(page, card, "Julian's Old Boys", 'team-0-player-1');
  await expect(card.locator('.num')).toHaveText(['1', '0']);
  await expect(page.locator('.boot-list')).toContainText('Facu B');
  await addGoal(page, card, "Julian's Old Boys", '');
  await expect(card.locator('.num')).toHaveText(['2', '0']);
  await card.getByRole('button', { name: 'Goals & scorers' }).click();
  const selects = page.locator('#goal-body select');
  await selects.nth(1).selectOption('team-0-player-1');
  await expect(page.locator('.goals-total')).toHaveText('2');
  await page.getByRole('button', { name: 'Remove goal 1', exact: true }).click();
  await page.locator('#goal-dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card.locator('.num')).toHaveText(['1', '0']);
  await expect(page.locator('.goals-total')).toHaveText('1');
  await expect.poll(() => backend.tournaments[1].state.m[0].hs).toBe(1);
  expect(backend.tournaments[0].state.m).toEqual(legacy.state.m);
});

test('new onsite tournament starts empty and leaves the old cup untouched', async ({ context, page }) => {
  const backend = await mockBackend(context);
  await page.goto(`/?cup=${LEGACY_ID}`);
  await page.getByRole('button', { name: 'New tournament' }).click();
  const form = page.locator('#create-form');
  await form.getByLabel('Tournament name').fill('Lisbon Legends');
  await page.locator('#create-onsite').selectOption('new');
  await form.getByLabel('New onsite name').fill('Lisbon · Spring 2027');
  for (const [index, name] of ['Ctrl Alt Defeat', 'Net Income', 'The Closers'].entries()) {
    await form.getByLabel(`Team ${index + 1} name`).fill(name);
    await form.locator(`[name="players${index}"]`).fill(`Captain ${index}*\nPlayer ${index}`);
  }
  await form.getByRole('button', { name: 'Let’s kick off' }).click();
  await expect(page.getByRole('heading', { exact: true, name: 'Lisbon Legends' })).toBeVisible();
  await expect(page.locator('#onsite-picker')).toHaveValue(backend.onsites[1].id);
  await expect(page.locator('.match .num')).toHaveText(Array(12).fill('0'));
  await expect(page.locator('.squad')).toContainText(['Ctrl Alt Defeat', 'Net Income', 'The Closers']);
  expect(backend.tournaments).toHaveLength(3);
  expect(backend.tournaments[0].state).toEqual({ ...legacy.state, teams: makeTeams() });
  await page.locator('#onsite-picker').selectOption(ONSITE_ID);
  await page.locator('#cup-picker').selectOption(LEGACY_ID);
  await expect(page.locator('.champion')).toContainText('Manchester Unreconciled');
});

test('offline goal survives reload and syncs only into its own cup', async ({ context, page }) => {
  const backend = await mockBackend(context);
  await openFresh(page);
  backend.offline = true;
  await addGoal(page, page.locator('[data-match-card="0"]'), "Julian's Old Boys", 'team-0-player-0');
  await expect(page.locator('#sync')).toHaveText('Offline · changes pending');
  await page.reload();
  await expect(page.locator('[data-match-card="0"] .num')).toHaveText(['1', '0']);
  backend.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#sync')).toHaveText('Live · shared');
  await expect.poll(() => backend.tournaments[1].state.m[0].hs).toBe(1);
  await page.locator('#cup-picker').selectOption(LEGACY_ID);
  await expect(page.locator('.champion')).toContainText('Manchester Unreconciled');
  expect(backend.tournaments[0].state.m).toEqual(legacy.state.m);
});

test('timers and settings stay on the current tournament', async ({ context, page }) => {
  const backend = await mockBackend(context);
  await openFresh(page);
  await page.getByRole('button', { name: 'Matchday settings' }).click();
  await page.locator('#settings-form').getByLabel('Match minutes').fill('10');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('10 min games · 2 min breaks')).toBeVisible();
  const card = page.locator('[data-match-card="0"]');
  await card.getByRole('button', { name: 'Start match' }).click();
  await expect(card.locator('[data-end]')).toContainText(/(10:00|9:59)/);
  await card.getByRole('button', { exact: true, name: 'Pause' }).click();
  await expect(card.locator('[data-remaining]')).toBeVisible();
  await card.getByRole('button', { name: 'Resume' }).click();
  await card.getByRole('button', { name: 'Stop timer' }).click();
  await expect(card.getByRole('button', { name: 'Start match' })).toBeVisible();
  expect(backend.tournaments[0].state.dur).toBe(13);
});

test('a complete cup can correct historical scorers without resetting results', async ({ context, page }) => {
  const backend = await mockBackend(context);
  await page.goto(`/?cup=${LEGACY_ID}`);
  const finalPanel = page.locator('.final-panel');
  await finalPanel.getByRole('button', { name: 'Goals & scorers' }).click();
  await page.locator('#goal-body select').first().selectOption('team-0-player-0');
  await page.locator('#goal-dialog').getByRole('button', { exact: true, name: 'Done' }).click();
  await expect(page.locator('.boot-list')).toContainText('Julian');
  await expect(finalPanel.locator('.num')).toHaveText(['2', '4']);
  await expect(page.locator('.champion')).toContainText('Manchester Unreconciled');
  await expect.poll(() => backend.tournaments[0].state.fin.goals?.length).toBe(6);
});

test('pre-migration fallback is read-only and preserves existing results', async ({ context, page }) => {
  await mockBackend(context, { missingSchema: true });
  await page.goto('/');
  await expect(page.locator('#notice')).toContainText('Database upgrade needed');
  await expect(page.locator('.champion')).toContainText('Manchester Unreconciled');
  await expect(page.getByRole('button', { name: 'New tournament' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Add goal for/ }).first()).toBeDisabled();
});

test('dark mode and reduced motion retain readable, non-overflowing layout', async ({ context, page }) => {
  await mockBackend(context);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(`/?cup=${LEGACY_ID}`);
  await expect(page.locator('.champion')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const animation = await page.locator('.champion').evaluate(element => getComputedStyle(element, '::before').animationName);
  expect(animation).toBe('none');
});
