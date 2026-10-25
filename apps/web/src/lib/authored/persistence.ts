/** Transaction owner for one replica. Retry recognizes the committed source
 * sequence before revision checks; incoming cursor and complete states commit
 * together. Pending source bytes never change after local acknowledgement. */
import { validateBindings } from "@nexus/authored/identity";
import { mergeChanges } from "@nexus/authored/merge";
import { encodeBytes, decodeBytes } from "@nexus/authored/documents";
import { DEVICE_SCHEMA } from "@nexus/authored/schema";
import { bindingQueries, compileQuery, SEARCH_INDEX_SQL, SEARCH_REMOVE_SQL } from "@nexus/authored/queries";
import { FORMAT_REVISION, MAX_COMMAND_BYTES, type AuthoredQuery, type CommitFrame, type CommitResult, type Corpus, type MergeResult, type QueryResult, type ReplicaState, type StateSelection, type Change, type FeedChange } from "@nexus/authored/types";
import type { Database } from "./sqlite";

export class Persistence {
  constructor(readonly db: Database) {}
  async initialize(accountId: string) {
    for (const sql of DEVICE_SCHEMA) await this.db.run(sql);
    await this.db.run("INSERT OR IGNORE INTO replica_state VALUES (1,?,?,0,0,0,0,?,0)", [accountId, crypto.randomUUID(), FORMAT_REVISION]);
    const state = await this.replica();
    if (state.account_id !== accountId || state.format_revision !== FORMAT_REVISION) throw new Error("authored account or format mismatch");
  }
  async readSnapshot(selection: StateSelection): Promise<{ replica: ReplicaState; states: Corpus }> {
    return { replica: await this.replica(), states: await this.states(selection) };
  }
  async replica(): Promise<ReplicaState> {
    const [row] = await this.db.all("SELECT account_id,replica_id,CAST(command_seq AS TEXT) AS command_seq,CAST(store_revision AS TEXT) AS store_revision,CAST(lamport AS TEXT) AS lamport,CAST(server_cursor AS TEXT) AS server_cursor,format_revision,provisioning_complete FROM replica_state WHERE singleton=1");
    if (!row) throw new Error("authored replica missing");
    return { account_id: String(row.account_id), replica_id: String(row.replica_id), command_seq: String(row.command_seq), store_revision: String(row.store_revision), lamport: String(row.lamport), server_cursor: String(row.server_cursor), format_revision: Number(row.format_revision), provisioning_complete: row.provisioning_complete === 1 };
  }
  async states(selection: StateSelection): Promise<Corpus> {
    const read = async <T>(table: string, key: string, ids: string[]): Promise<T[]> => {
      if (ids.length === 0) return [];
      if (ids.length > 1000) throw new Error("authored state read exceeds bound");
      const rows = await this.db.all(`SELECT state_json${table === "resources" ? ",merge_bytes" : ""} FROM ${table} WHERE ${key} IN (${ids.map(() => "?").join(",")})`, ids);
      return rows.map(row => {
        const state = JSON.parse(String(row.state_json));
        if (table === "resources" && state.kind !== "highlight") {
          if (!(row.merge_bytes instanceof Uint8Array)) throw new Error("authored merge bytes missing");
          state[state.kind === "note" ? "body_state" : "title_state"] = encodeBytes(row.merge_bytes);
        }
        return state as T;
      });
    };
    return { resources: await read("resources", "ref", selection.refs), links: await read("links", "link_id", selection.link_ids), passages: await read("passages", "anchor_id", selection.anchor_ids), source_stubs: await read("source_stubs", "source_ref", selection.source_refs) };
  }
  async changeStates(change: Change): Promise<Corpus> {
    const selection = selectionFor(change);
    for (const binding of bindingQueries(change)) {
      const known = await this.query(binding.query);
      if (known.binding_id !== null) selection[binding.selector].push(known.binding_id);
    }
    return this.states(selection);
  }
  async query(query: AuthoredQuery): Promise<QueryResult> {
    const compiled = compileQuery(query);
    const raw = await this.db.all(compiled.sql, compiled.params);
    if (query.kind === "binding") return { store_revision: (await this.replica()).store_revision, rows: [], next_cursor: null, previous_cursor: null, positions: [], binding_id: raw[0] ? String(raw[0].binding_id) : null };
    if (query.kind === "positions") {
      const positions = raw.map(row => JSON.parse(String(row.position_json)));
      return { store_revision: (await this.replica()).store_revision, rows: [], positions, next_cursor: query.at.kind === "tie" && positions.length === Math.min(100, query.at.limit) ? String(raw.at(-1)?.cursor_json) : null, previous_cursor: null, binding_id: null };
    }
    const rows = raw.map(row => ({ resource: JSON.parse(String(row.projection_json)), link: row.link_json === null ? null : JSON.parse(String(row.link_json)) }));
    const last = rows.at(-1);
    let next: string | null = null;
    if ("limit" in query && rows.length === Math.min(100, query.limit) && last) {
      const cursor = raw.at(-1)?.cursor_json;
      next = typeof cursor === "string" ? cursor : last.resource.ref;
    }
    return { store_revision: (await this.replica()).store_revision, rows, next_cursor: next, previous_cursor: typeof raw[0]?.previous_cursor === "string" ? raw[0].previous_cursor : null, binding_id: null, positions: [] };
  }
  async write(states: MergeResult) {
    for (const state of states.resources) {
      const projection = states.projections.find(value => value.ref === state.ref);
      if (!projection) throw new Error("missing authored projection");
      const { body_state: body, title_state: title, ...metadata } = { body_state: null, title_state: null, ...state };
      const bytes = body ?? title;
      await this.db.run("INSERT INTO resources(ref,kind,state_json,merge_bytes,projection_json,visible,body_text,title,local_date,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET state_json=excluded.state_json,merge_bytes=excluded.merge_bytes,projection_json=excluded.projection_json,visible=excluded.visible,body_text=excluded.body_text,title=excluded.title,local_date=excluded.local_date,source_ref=excluded.source_ref", [state.ref, state.kind, JSON.stringify(metadata), bytes === null ? null : decodeBytes(bytes), JSON.stringify(projection), Number(projection.visible), projection.body_text, projection.title, projection.local_date, projection.source_ref]);
      await this.db.run("DELETE FROM reference_index WHERE owner_ref=?", [state.ref]);
      for (const ref of new Set(projection.embedded_refs)) await this.db.run("INSERT INTO reference_index(owner_ref,target_ref) VALUES(?,?)", [state.ref, ref]);
    }
    for (const state of states.links) {
      const visible = Object.entries(state.add_vv).some(([id, value]) => BigInt(value) > BigInt(state.remove_vv[id] ?? "0"));
      await this.db.run("INSERT INTO links VALUES(?,?,?,?,?,?,?) ON CONFLICT(link_id) DO UPDATE SET position_a=excluded.position_a,position_b=excluded.position_b,visible=excluded.visible,state_json=excluded.state_json", [state.link_id, state.endpoint_a, state.endpoint_b, state.position_a?.value ?? null, state.position_b?.value ?? null, Number(visible), JSON.stringify(state)]);
    }
    for (const state of states.passages) await this.db.run("INSERT INTO passages VALUES(?,?,?,?) ON CONFLICT(anchor_id) DO UPDATE SET state_json=excluded.state_json", [state.anchor_id, state.source_ref, JSON.stringify([state.source_ref, state.normalized_exact, state.prefix, state.suffix]), JSON.stringify(state)]);
    for (const state of states.source_stubs) await this.db.run("INSERT INTO source_stubs VALUES(?,?) ON CONFLICT(source_ref) DO UPDATE SET state_json=excluded.state_json", [state.source_ref, JSON.stringify(state)]);
    const indexed = new Set([...states.resources.map(state => state.ref), ...states.passages.map(state => `passage_anchor:${state.anchor_id}`), ...states.source_stubs.map(state => state.source_ref)]);
    for (const ref of indexed) {
      await this.db.run(SEARCH_REMOVE_SQL, [ref]);
      await this.db.run(SEARCH_INDEX_SQL, [ref]);
    }
  }
  async commit(frame: CommitFrame): Promise<CommitResult> {
    const bytes = JSON.stringify(frame.change);
    if (new TextEncoder().encode(bytes).byteLength > MAX_COMMAND_BYTES) throw new Error("authored command exceeds 2 mib");
    return this.db.transaction(async () => {
      const current = await this.replica();
      if (frame.replica_id !== current.replica_id) throw new Error("wrong authored replica");
      if (BigInt(frame.change.command_seq) <= BigInt(current.command_seq)) return { kind: "committed", command_seq: frame.change.command_seq, store_revision: current.store_revision };
      if (BigInt(frame.change.command_seq) !== BigInt(current.command_seq) + BigInt(1)) throw new Error("authored command sequence gap");
      if (frame.expected_store_revision !== current.store_revision) return { kind: "stale", store_revision: current.store_revision, states: await this.changeStates(frame.change) };
      const states = await this.changeStates(frame.change);
      await validateBindings(current.account_id, states, [frame.change]);
      await this.write(mergeChanges(states, [frame.change]));
      await this.db.run("INSERT INTO pending_changes VALUES(?,?,?)", [BigInt(frame.change.command_seq), bytes, new TextEncoder().encode(bytes).byteLength]);
      const revision = (BigInt(current.store_revision) + BigInt(1)).toString();
      await this.db.run("UPDATE replica_state SET command_seq=?,store_revision=?,lamport=MAX(lamport,?) WHERE singleton=1", [BigInt(frame.change.command_seq), BigInt(revision), BigInt(frame.change.lamport)]);
      return { kind: "committed", command_seq: frame.change.command_seq, store_revision: revision };
    });
  }
  async applyRemote(entries: FeedChange[], nextCursor: string): Promise<ReplicaState> {
    return this.db.transaction(async () => {
      let current = await this.replica();
      for (const entry of entries) {
        if (BigInt(entry.server_seq) <= BigInt(current.server_cursor)) continue;
        if (BigInt(entry.server_seq) !== BigInt(current.server_cursor) + BigInt(1)) throw new Error("authored feed sequence gap");
        const states = await this.changeStates(entry.change);
        await validateBindings(current.account_id, states, [entry.change]);
        await this.write(mergeChanges(states, [entry.change]));
        await this.db.run("UPDATE replica_state SET server_cursor=?,store_revision=store_revision+1,lamport=MAX(lamport,?) WHERE singleton=1", [BigInt(entry.server_seq), BigInt(entry.change.lamport)]);
        current = await this.replica();
      }
      if (current.server_cursor !== nextCursor) throw new Error("authored feed cursor disagrees with applied commands");
      return current;
    });
  }
  async resetProvisioning() {
    await this.db.transaction(async () => {
      for (const table of ["resources", "links", "passages", "source_stubs", "reference_index", "search_documents"]) await this.db.run(`DELETE FROM ${table}`);
    });
  }
  async stage(states: MergeResult) { await this.db.transaction(() => this.write(states)); }
  async finishProvisioning(cursor: string, counts: Record<string, number>, lamport: string) {
    await this.db.transaction(async () => {
      for (const table of ["resources", "links", "passages", "source_stubs"]) {
        const [row] = await this.db.all(`SELECT COUNT(*) AS count FROM ${table}`);
        if (Number(row.count) !== counts[table]) throw new Error("authored snapshot contains duplicate identities");
      }
      await this.db.run("UPDATE replica_state SET provisioning_complete=1,server_cursor=?,store_revision=store_revision+1,lamport=MAX(lamport,?) WHERE singleton=1", [BigInt(cursor), BigInt(lamport)]);
    });
  }
  async pending(): Promise<Change[]> {
    const rows = await this.db.all("SELECT change_json,byte_length FROM pending_changes ORDER BY command_seq LIMIT 100");
    const changes: Change[] = [];
    let bytes = 256;
    for (const row of rows) { if (bytes + Number(row.byte_length) > 3 * 1024 * 1024 - 1024) break; bytes += Number(row.byte_length) + 1; changes.push(JSON.parse(String(row.change_json))); }
    return changes;
  }
  async acknowledge(sequence: string) {
    await this.db.transaction(async () => {
      const state = await this.replica();
      if (BigInt(sequence) > BigInt(state.command_seq)) throw new Error("server acknowledged unknown authored command");
      await this.db.run("DELETE FROM pending_changes WHERE command_seq<=?", [BigInt(sequence)]);
    });
  }
}
export function selectionFor(change: Change): StateSelection {
  return { refs: change.resources.map(state => state.ref), link_ids: change.links.map(state => state.link_id), anchor_ids: change.passages.map(state => state.anchor_id), source_refs: change.source_stubs.map(state => state.source_ref) };
}
