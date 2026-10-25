/** One device schema. Canonical JSON and derived columns commit together; projections
 * are never an independent authority. Both hosts require FTS5 and synchronous FULL. */
export const DEVICE_SCHEMA = [
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = FULL",
  `CREATE TABLE IF NOT EXISTS replica_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL, replica_id TEXT NOT NULL, command_seq INTEGER NOT NULL, store_revision INTEGER NOT NULL, lamport INTEGER NOT NULL, server_cursor INTEGER NOT NULL, format_revision INTEGER NOT NULL, provisioning_complete INTEGER NOT NULL CHECK(provisioning_complete IN (0,1)))`,
  `CREATE TABLE IF NOT EXISTS resources (ref TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('note','page','highlight')), state_json TEXT NOT NULL, merge_bytes BLOB, projection_json TEXT NOT NULL, visible INTEGER NOT NULL, body_text TEXT, title TEXT, local_date TEXT UNIQUE, source_ref TEXT)`,
  `CREATE INDEX IF NOT EXISTS resources_annotations ON resources(source_ref,ref) WHERE visible=1`,
  `CREATE INDEX IF NOT EXISTS resources_pages ON resources(title,ref) WHERE kind='page' AND visible=1`,
  `CREATE TABLE IF NOT EXISTS links (link_id TEXT PRIMARY KEY, endpoint_a TEXT NOT NULL, endpoint_b TEXT NOT NULL, position_a TEXT, position_b TEXT, visible INTEGER NOT NULL, state_json TEXT NOT NULL, UNIQUE(endpoint_a,endpoint_b), CHECK(endpoint_a<endpoint_b))`,
  `CREATE INDEX IF NOT EXISTS links_a ON links(endpoint_a,position_a,link_id)`,
  `CREATE INDEX IF NOT EXISTS links_b ON links(endpoint_b,position_b,link_id)`,
  `CREATE TABLE IF NOT EXISTS passages (anchor_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, semantic_key TEXT NOT NULL UNIQUE, state_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS source_stubs (source_ref TEXT PRIMARY KEY, state_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending_changes (command_seq INTEGER PRIMARY KEY, change_json TEXT NOT NULL, byte_length INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reference_index (owner_ref TEXT NOT NULL, target_ref TEXT NOT NULL, PRIMARY KEY(owner_ref,target_ref))`,
  `CREATE INDEX IF NOT EXISTS reference_incoming ON reference_index(target_ref,owner_ref)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(ref UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')`,
] as const;
