/** One device schema. Canonical JSON and derived columns commit together; projections
 * are never an independent authority. Both hosts require FTS5 and synchronous FULL. */
import { PAGE_TITLE_SQL } from "./queries.ts";
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
] as const;
