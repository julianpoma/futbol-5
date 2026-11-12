import { applyAction, LEGACY_ID, normalizeState, ONSITE_ID } from './state.js';

const DIRECTORY_KEY = 'double-cup-directory-v1';
const CREATE_KEY = 'double-cup-create-v1';
const entryKey = id => `double-cup-tournament-v1:${id}`;

export default class CupStore {
  #db;
  #storage;
  #entries = new Map();
  #busy = new Set();
  #listeners = new Set();
  #channel;
  #directory = { onsites: [], tournaments: [] };
  #currentId = null;
  #legacy = false;
  #message = '';
  #storageError = false;
  #pendingCreate;

  constructor(db, storage) {
    this.#db = db;
    try { this.#storage = storage ?? globalThis.localStorage; }
    catch { this.#storageError = true; }
    this.#directory = this.#read(DIRECTORY_KEY) || this.#directory;
    this.#pendingCreate = this.#read(CREATE_KEY);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get snapshot() {
    const entry = this.#entries.get(this.#currentId);
    return {
      id: this.#currentId,
      ...this.#directory,
      legacy: this.#legacy,
      message: this.#message,
      pendingCreate: this.#pendingCreate,
      pendingLegacy: Boolean(this.#read('futbol5-pending-v1')?.length),
      queueLength: entry?.queue.length || 0,
      state: entry?.state || null,
      status: entry?.status || 'Connecting…',
      storageError: this.#storageError,
      totalPending: [...this.#entries.values()].reduce((total, item) => total + item.queue.length, 0),
    };
  }

  #read(key) {
    try { return JSON.parse(this.#storage.getItem(key)); }
    catch { this.#storageError = true; return null; }
  }

  #write(key, value) {
    try {
      this.#storage.setItem(key, JSON.stringify(value));
      this.#storageError = false;
    } catch {
      this.#storageError = true;
    }
  }

  #emit() {
    for (const listener of this.#listeners) listener(this.snapshot);
  }

  #persist(id) {
    const entry = this.#entries.get(id);
    this.#write(entryKey(id), { queue: entry.queue, state: entry.state });
  }

  async loadDirectory() {
    if (!this.#db) throw new Error('Connection unavailable. Check your network and reload.');

    const [onsites, tournaments] = await Promise.all([
      this.#db.from('cup_onsites').select('id,name').order('name'),
      this.#db.from('cup_tournaments').select('id,name,onsite_id,legacy_source_id').order('name'),
    ]);
    const error = onsites.error || tournaments.error;
    if (error) throw error;

    this.#legacy = false;
    this.#message = '';
    this.#directory = { onsites: onsites.data, tournaments: tournaments.data };
    this.#write(DIRECTORY_KEY, this.#directory);
    this.#emit();
  }

  async start(preferredId) {
    try {
      await this.loadDirectory();
    } catch (error) {
      if (['PGRST205', '42P01'].includes(error.code)) {
        await this.#loadLegacy();
        return;
      }
      this.#message = 'Could not refresh the tournament list. Check your connection and retry.';
    }

    const available = this.#directory.tournaments;
    for (const tournament of available) {
      if (this.#entries.has(tournament.id)) continue;
      const cached = this.#read(entryKey(tournament.id));
      if (cached?.state && cached.queue?.length) {
        this.#entries.set(tournament.id, {
          queue: cached.queue,
          state: normalizeState(cached.state),
          status: 'Offline · changes pending',
        });
      }
    }

    const id = available.some(item => item.id === preferredId) ? preferredId : available[0]?.id;
    if (id) await this.select(id);
    else this.#emit();
    for (const pendingId of this.#entries.keys()) {
      if (pendingId !== id && this.#entries.get(pendingId).queue.length) void this.sync(pendingId);
    }
  }

  async #loadLegacy() {
    this.#legacy = true;
    this.#message = 'Database upgrade needed. Existing results are shown read-only until the new migration is applied.';
    this.#currentId = LEGACY_ID;
    this.#directory = {
      onsites: [{ id: ONSITE_ID, name: 'Buenos Aires · Nov 2026' }],
      tournaments: [{ id: LEGACY_ID, name: 'Buenos Aires Nov 26 Cup', onsite_id: ONSITE_ID }],
    };
    const result = await this.#db.from('tournament_state').select('state').eq('id', 1).single();
    this.#entries.set(LEGACY_ID, {
      queue: [],
      state: result.data ? normalizeState(result.data.state) : null,
      status: result.error ? 'Unable to load results' : 'Archive · read-only',
    });
    this.#emit();
  }

  async select(id) {
    if (!this.#directory.tournaments.some(item => item.id === id)) return;

    this.#currentId = id;
    if (!this.#entries.has(id)) {
      const cached = this.#read(entryKey(id));
      this.#entries.set(id, {
        queue: Array.isArray(cached?.queue) ? cached.queue : [],
        state: cached?.state ? normalizeState(cached.state) : null,
        status: cached ? 'Connecting · cached' : 'Connecting…',
      });
    }

    if (this.#channel) this.#db?.removeChannel(this.#channel);
    if (this.#db && !this.#legacy) {
      this.#channel = this.#db.channel(`cup:${id}`)
        .on('postgres_changes', { event: 'UPDATE', filter: `id=eq.${id}`, schema: 'public', table: 'cup_tournaments' }, () => this.sync(id))
        .subscribe();
    }

    this.#emit();
    await this.sync(id);
  }

  save(action) {
    const id = this.#currentId;
    const entry = this.#entries.get(id);
    if (this.#legacy || !entry?.state) return;

    const operation = { opId: crypto.randomUUID(), ...action };
    entry.state = applyAction(entry.state, operation);
    entry.queue.push(operation);
    entry.status = 'Saving…';
    this.#persist(id);
    this.#emit();
    void this.sync(id);
  }

  async sync(id = this.#currentId) {
    if (!id || this.#legacy || this.#busy.has(id)) return;

    const entry = this.#entries.get(id);
    if (!entry || !this.#db) {
      if (entry) entry.status = 'Offline · changes pending';
      this.#emit();
      return;
    }

    this.#busy.add(id);
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const result = await this.#db.from('cup_tournaments').select('state,version').eq('id', id).single();
        if (result.error) throw result.error;

        let state = normalizeState(result.data.state);
        const count = entry.queue.length;
        const batch = entry.queue.slice(0, count);
        for (const action of batch) state = applyAction(state, action);

        if (count) {
          const update = await this.#db.from('cup_tournaments')
            .update({ state, version: result.data.version + 1 })
            .eq('id', id).eq('version', result.data.version).select('version');
          if (update.error) throw update.error;
          if (!update.data.length) continue;
          entry.queue.splice(0, count);
        }

        for (const action of entry.queue) state = applyAction(state, action);
        entry.state = state;
        entry.status = entry.queue.length ? 'Saving…' : 'Live · shared';
        this.#persist(id);
        return;
      }

      entry.status = 'Busy pitch · retrying';
    } catch {
      entry.status = entry.queue.length ? 'Offline · changes pending' : 'Offline · cached';
    } finally {
      this.#busy.delete(id);
      this.#emit();
    }
  }

  async syncPending() {
    const ids = [...this.#entries.keys()].filter(id => id === this.#currentId || this.#entries.get(id).queue.length);
    await Promise.allSettled(ids.map(id => this.sync(id)));
  }

  async createTournament(payload) {
    if (this.#legacy) throw new Error('Apply the database migration before creating tournaments.');
    if (!this.#db) throw new Error('You need a connection to create a tournament.');

    // Persist the request ID before sending; retries can never create another cup.
    this.#pendingCreate ||= payload;
    this.#write(CREATE_KEY, this.#pendingCreate);
    this.#emit();
    if (this.#storageError) throw new Error('Enable browser storage before creating a tournament.');
    const request = this.#pendingCreate;
    const result = await this.#db.rpc('create_cup_tournament', {
      p_id: request.id,
      p_name: request.name,
      p_onsite_id: request.onsiteId,
      p_onsite_name: request.onsiteName,
      p_state: request.state,
    });
    if (result.error) throw result.error;

    await this.loadDirectory();
    this.#pendingCreate = null;
    this.#write(CREATE_KEY, null);
    await this.select(result.data);
    this.#emit();
    return result.data;
  }
}
