/** One device schema. Canonical JSON and derived columns commit together; projections
 * are never an independent authority. Both hosts require FTS5 and synchronous FULL. */
import { PAGE_TITLE_SQL } from "./queries.ts";
/** Both outboxes read the server's maximum 64 changes in immutable source order;
 * each host then takes the prefix fitting the existing upload byte budget. */
export const PENDING_CHANGES_SQL = "SELECT change_json,byte_length FROM pending_changes ORDER BY command_seq LIMIT 64";
export const DEVICE_SCHEMA = [
  "PRAGMA foreign_keys = ON",
  "PRAGMA synchronous = FULL",
  `CREATE TABLE IF NOT EXISTS replica_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL, replica_id TEXT NOT NULL, command_seq INTEGER NOT NULL, store_revision INTEGER NOT NULL, lamport INTEGER NOT NULL, server_cursor INTEGER NOT NULL, format_revision INTEGER NOT NULL, provisioning_complete INTEGER NOT NULL CHECK(provisioning_complete IN (0,1)))`,
  `CREATE TABLE IF NOT EXISTS resources (ref TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('note','page','highlight')), state_json TEXT NOT NULL, merge_bytes BLOB, projection_json TEXT NOT NULL, visible INTEGER NOT NULL, body_text TEXT, title TEXT, local_date TEXT UNIQUE, source_ref TEXT)`,
  `CREATE INDEX IF NOT EXISTS resources_annotations ON resources(source_ref,ref) WHERE visible=1`,
  `CREATE INDEX IF NOT EXISTS resources_pages ON resources(${PAGE_TITLE_SQL},ref) WHERE kind='page' AND visible=1`,
  `CREATE TABLE IF NOT EXISTS links (link_id TEXT PRIMARY KEY, endpoint_a TEXT NOT NULL, endpoint_b TEXT NOT NULL, position_a TEXT, position_b TEXT, visible INTEGER NOT NULL, state_json TEXT NOT NULL, UNIQUE(endpoint_a,endpoint_b), CHECK(endpoint_a<endpoint_b))`,
  `CREATE INDEX IF NOT EXISTS links_a ON links(endpoint_a,position_a,link_id)`,
  `CREATE INDEX IF NOT EXISTS links_b ON links(endpoint_b,position_b,link_id)`,
  `CREATE TABLE IF NOT EXISTS passages (anchor_id TEXT PRIMARY KEY, source_ref TEXT NOT NULL, semantic_key TEXT NOT NULL UNIQUE, state_json TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS passage_bindings ON passages(source_ref,json_extract(state_json,'$.normalized_exact'),json_extract(state_json,'$.prefix'),json_extract(state_json,'$.suffix'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS passages_ref ON passages('passage_anchor:'||anchor_id)`,
  `CREATE TABLE IF NOT EXISTS source_stubs (source_ref TEXT PRIMARY KEY, state_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending_changes (command_seq INTEGER PRIMARY KEY, change_json TEXT NOT NULL, byte_length INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reference_index (owner_ref TEXT NOT NULL, target_ref TEXT NOT NULL, PRIMARY KEY(owner_ref,target_ref))`,
  `CREATE INDEX IF NOT EXISTS reference_incoming ON reference_index(target_ref,owner_ref)`,
  `CREATE TABLE IF NOT EXISTS search_documents (rowid INTEGER PRIMARY KEY,ref TEXT NOT NULL UNIQUE,text TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text,content='search_documents',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2')`,
  `CREATE TRIGGER IF NOT EXISTS search_documents_insert AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,text) VALUES(new.rowid,new.text); END`,
  `CREATE TRIGGER IF NOT EXISTS search_documents_delete AFTER DELETE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,text) VALUES('delete',old.rowid,old.text); END`,
  `CREATE TRIGGER IF NOT EXISTS search_documents_update AFTER UPDATE OF text ON search_documents WHEN old.text IS NOT new.text BEGIN INSERT INTO search_fts(search_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO search_fts(rowid,text) VALUES(new.rowid,new.text); END`,
  `CREATE TABLE IF NOT EXISTS scope_state (singleton INTEGER PRIMARY KEY, active_revision TEXT, staging_revision TEXT, metadata_cursor TEXT, metadata_complete INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO scope_state(singleton) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS scope_facts (revision TEXT NOT NULL,fact_key TEXT NOT NULL,kind TEXT NOT NULL,owner_ref TEXT NOT NULL,target_ref TEXT,state_json TEXT NOT NULL,PRIMARY KEY(revision,fact_key))`,
  `CREATE INDEX IF NOT EXISTS scope_facts_owner ON scope_facts(revision,kind,owner_ref,target_ref)`,
  `CREATE TABLE IF NOT EXISTS scope_readings (revision TEXT NOT NULL,reading_ref TEXT NOT NULL,source_ref TEXT NOT NULL,source_kind TEXT NOT NULL,body_generation INTEGER,source_generation INTEGER,PRIMARY KEY(revision,reading_ref))`,
  `CREATE INDEX IF NOT EXISTS scope_readings_source ON scope_readings(revision,source_ref,reading_ref)`,
  `CREATE TABLE IF NOT EXISTS scope_intervals (revision TEXT NOT NULL,interval_key TEXT NOT NULL,reading_ref TEXT NOT NULL,fragment_id TEXT NOT NULL,fragment_idx INTEGER NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,purpose TEXT NOT NULL,start_cut INTEGER NOT NULL,end_cut INTEGER NOT NULL,PRIMARY KEY(revision,interval_key))`,
  `CREATE INDEX IF NOT EXISTS scope_intervals_reading ON scope_intervals(revision,reading_ref,fragment_idx,start_offset,interval_key)`,
  `CREATE TABLE IF NOT EXISTS scope_text (revision TEXT NOT NULL,reading_ref TEXT NOT NULL,interval_key TEXT NOT NULL,start_offset INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(revision,reading_ref,interval_key,start_offset))`,
  `CREATE TABLE IF NOT EXISTS scope_normalized (revision TEXT NOT NULL,reading_ref TEXT NOT NULL,interval_key TEXT NOT NULL,start_offset INTEGER NOT NULL,normalized_text TEXT NOT NULL,edits_json TEXT NOT NULL,PRIMARY KEY(revision,reading_ref,interval_key,start_offset))`,
  `CREATE TABLE IF NOT EXISTS scope_normalized_complete (revision TEXT NOT NULL,reading_ref TEXT NOT NULL,interval_key TEXT NOT NULL,PRIMARY KEY(revision,reading_ref,interval_key))`,
  `CREATE TABLE IF NOT EXISTS scope_text_complete (revision TEXT NOT NULL,reading_ref TEXT NOT NULL,PRIMARY KEY(revision,reading_ref))`,
  `CREATE TABLE IF NOT EXISTS scope_text_progress (revision TEXT NOT NULL,reading_ref TEXT NOT NULL,cursor TEXT,raw_complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(revision,reading_ref))`,
  `CREATE TABLE IF NOT EXISTS scope_revocations (scope_ref TEXT PRIMARY KEY)`,
] as const;
