import { freshState, LEGACY_ID, ONSITE_ID } from '../../src/state.js';

export default class FakeDb {
  offline = false;
  loseResponse = false;
  conflict = false;
  missingSchema = false;
  delayRead = null;
  rpcCalls = [];
  onsites = [{ id: ONSITE_ID, name: 'Buenos Aires · Nov 2026' }];
  tournaments = [{ id: LEGACY_ID, legacy_source_id: 1, name: 'BA Cup', onsite_id: ONSITE_ID, state: freshState(), version: 0 }];

  from(table) {
    let update;
    let single = false;
    const filters = {};
    const query = {
      eq(key, value) { filters[key] = value; return query; },
      order() { return query; },
      select() { return query; },
      single() { single = true; return query; },
      update(value) { update = value; return query; },
      then: (resolve, reject) => Promise.resolve().then(async () => {
        if (this.offline) throw new Error('Offline');
        if (this.missingSchema && table !== 'tournament_state') return { error: { code: 'PGRST205' } };
        if (this.delayRead && !update && Object.hasOwn(filters, 'id')) await this.delayRead();
        if (table === 'tournament_state') return { data: { state: freshState() } };
        const source = table === 'cup_onsites' ? this.onsites : this.tournaments;
        const rows = source.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value));

        if (update && this.conflict) {
          this.conflict = false;
          this.tournaments[0].version++;
          return { data: [] };
        }
        if (update) {
          rows.forEach(row => Object.assign(row, structuredClone(update)));
          if (this.loseResponse) { this.loseResponse = false; throw new Error('Response lost'); }
        }
        return { data: structuredClone(single ? rows[0] : rows), error: null };
      }).then(resolve, reject),
    };
    return query;
  }

  channel() {
    const channel = { on: () => channel, subscribe: () => channel };
    return channel;
  }

  removeChannel() {}

  async rpc(name, args) {
    this.rpcCalls.push({ name, ...structuredClone(args) });
    if (this.offline) return { error: new Error('Offline') };
    if (!this.tournaments.some(item => item.id === args.p_id)) {
      this.tournaments.push({ id: args.p_id, name: args.p_name, onsite_id: args.p_onsite_id, state: structuredClone(args.p_state), version: 0 });
    }
    if (this.loseResponse) { this.loseResponse = false; return { error: new Error('Response lost') }; }
    return { data: args.p_id };
  }
}

export class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.get(key) || null; }
  setItem(key, value) { this.#data.set(key, value); }
}
