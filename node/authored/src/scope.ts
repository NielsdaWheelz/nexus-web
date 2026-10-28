/** Read-only search inputs. A revision publishes only after bounded metadata and
 * authorized text pages finish. These facts grant no reader or authored ownership. */
export type SearchScope = { kind: "all"; id: null } | { kind: "media" | "library" | "conversation"; id: string };
export type SearchFamily = "notes" | "highlights" | "saved_passages" | "documents" | "conversations" | "people" | "libraries" | "readings";
export interface ScopeReading {
  kind: "reading"; reading_ref: string; source_ref: string; source_kind: string;
  body_generation: number | null; source_generation: number | null;
}
export interface ScopeInterval {
  kind: "interval"; interval_key: string; reading_ref: string; fragment_id: string;
  fragment_idx: number; start_offset: number; end_offset: number;
  purpose: "body" | "required_note"; start_cut: boolean; end_cut: boolean;
}
export type ScopeInput =
  | { kind: "scope"; scope_ref: string }
  | { kind: "workspace_member"; reading_ref: string }
  | { kind: "media_member"; root_ref: string; reading_ref: string }
  | { kind: "library_member"; library_ref: string; reading_ref: string }
  | { kind: "conversation_fact"; conversation_ref: string; target_ref: string }
  | { kind: "source_alias"; reading_ref: string; source_ref: string }
  | { kind: "highlight_member"; highlight_ref: string; reading_ref: string }
  | ScopeReading | ScopeInterval;
export type ScopeInputsRequest =
  | { kind: "status"; revision: string | null; active_refs: string[] }
  | { kind: "metadata"; revision: string | null; cursor: string | null }
  | { kind: "finish"; revision: string };
export interface ScopeInputsPage {
  revision: string; restart: boolean; revoked_refs: string[];
  records: ScopeInput[]; next_cursor: string | null;
}
export interface ScopeTextRequest { revision: string; reading_ref: string; cursor: string | null }
export interface ScopeTextChunk {
  interval_key: string; fragment_id: string; fragment_idx: number; start_offset: number;
  text: string;
}
export interface ScopeTextPage {
  revision: string; restart: boolean; revoked_refs: string[]; reading_ref: string;
  chunks: ScopeTextChunk[]; next_cursor: string | null;
}
/** Fixed storage statements are packaged for Android too; bridge callers send
 * values and operation names, never SQL. Revisions isolate incomplete inputs. */
export const SCOPE_SQL = {
  scope_state: `SELECT active_revision,staging_revision,metadata_cursor,metadata_complete FROM scope_state WHERE singleton=1`,
  // Published provenance is a relationship proof, independent of reading permission
  // and its blacklist. The destination reader must own its own authorized bounds.
  scope_source_alias: `SELECT target_ref AS canonical_source_ref FROM scope_facts
    WHERE revision=(SELECT active_revision FROM scope_state WHERE singleton=1) AND kind='source_alias' AND owner_ref=?1
    UNION SELECT source_ref FROM scope_readings
    WHERE revision=(SELECT active_revision FROM scope_state WHERE singleton=1) AND reading_ref=?1 LIMIT 1`,
  scope_active_refs: `SELECT scope_ref FROM (
    SELECT owner_ref AS scope_ref FROM scope_facts WHERE kind='scope' AND revision IN (SELECT active_revision FROM scope_state UNION ALL SELECT staging_revision FROM scope_state)
    UNION SELECT reading_ref FROM scope_readings WHERE revision IN (SELECT active_revision FROM scope_state UNION ALL SELECT staging_revision FROM scope_state)
    UNION SELECT scope_ref FROM scope_revocations
  ) WHERE (? IS NULL OR scope_ref>?) ORDER BY scope_ref LIMIT 100`,
  scope_repair_refs: `SELECT v.scope_ref FROM scope_revocations v WHERE v.scope_ref IN (SELECT value FROM json_each(?)) AND (
    EXISTS(SELECT 1 FROM scope_facts f WHERE f.revision=(SELECT active_revision FROM scope_state) AND f.kind='scope' AND f.owner_ref=v.scope_ref)
    OR EXISTS(SELECT 1 FROM scope_readings r WHERE r.revision=(SELECT active_revision FROM scope_state) AND r.reading_ref=v.scope_ref)
  ) ORDER BY v.scope_ref`,
  scope_pending_reading: `SELECT r.reading_ref,p.cursor,COALESCE(p.raw_complete,0) AS raw_complete FROM scope_readings r
    LEFT JOIN scope_text_progress p ON p.revision=r.revision AND p.reading_ref=r.reading_ref
    WHERE r.revision=(SELECT staging_revision FROM scope_state) AND NOT EXISTS (
      SELECT 1 FROM scope_text_complete c WHERE c.revision=r.revision AND c.reading_ref=r.reading_ref
    ) ORDER BY r.reading_ref LIMIT 1`,
  scope_begin: `UPDATE scope_state SET staging_revision=?,metadata_cursor=NULL,metadata_complete=0 WHERE singleton=1`,
  scope_discard: `UPDATE scope_state SET staging_revision=NULL,metadata_cursor=NULL,metadata_complete=0 WHERE singleton=1`,
  scope_metadata_facts: `INSERT OR IGNORE INTO scope_facts(revision,fact_key,kind,owner_ref,target_ref,state_json)
    SELECT ?,json_array(json_extract(value,'$.kind'),COALESCE(json_extract(value,'$.scope_ref'),json_extract(value,'$.root_ref'),json_extract(value,'$.library_ref'),json_extract(value,'$.conversation_ref'),json_extract(value,'$.highlight_ref'),json_extract(value,'$.reading_ref')),CASE WHEN json_extract(value,'$.kind')='source_alias' THEN json_extract(value,'$.source_ref') ELSE COALESCE(json_extract(value,'$.reading_ref'),json_extract(value,'$.target_ref')) END),
      json_extract(value,'$.kind'),COALESCE(json_extract(value,'$.scope_ref'),json_extract(value,'$.root_ref'),json_extract(value,'$.library_ref'),json_extract(value,'$.conversation_ref'),json_extract(value,'$.highlight_ref'),json_extract(value,'$.reading_ref')),CASE WHEN json_extract(value,'$.kind')='source_alias' THEN json_extract(value,'$.source_ref') ELSE COALESCE(json_extract(value,'$.reading_ref'),json_extract(value,'$.target_ref')) END,value
    FROM json_each(?) WHERE json_extract(value,'$.kind') IN ('scope','workspace_member','media_member','library_member','conversation_fact','source_alias','highlight_member')`,
  scope_metadata_readings: `INSERT OR IGNORE INTO scope_readings(revision,reading_ref,source_ref,source_kind,body_generation,source_generation)
    SELECT ?,json_extract(value,'$.reading_ref'),json_extract(value,'$.source_ref'),json_extract(value,'$.source_kind'),json_extract(value,'$.body_generation'),json_extract(value,'$.source_generation') FROM json_each(?) WHERE json_extract(value,'$.kind')='reading'`,
  scope_metadata_intervals: `INSERT OR IGNORE INTO scope_intervals(revision,interval_key,reading_ref,fragment_id,fragment_idx,start_offset,end_offset,purpose,start_cut,end_cut)
    SELECT ?,json_extract(value,'$.interval_key'),json_extract(value,'$.reading_ref'),json_extract(value,'$.fragment_id'),json_extract(value,'$.fragment_idx'),json_extract(value,'$.start_offset'),json_extract(value,'$.end_offset'),json_extract(value,'$.purpose'),json_extract(value,'$.start_cut'),json_extract(value,'$.end_cut') FROM json_each(?) WHERE json_extract(value,'$.kind')='interval'`,
  scope_metadata_cursor: `UPDATE scope_state SET metadata_cursor=?,metadata_complete=? WHERE staging_revision=?`,
  scope_text_chunks: `INSERT OR REPLACE INTO scope_text(revision,reading_ref,interval_key,start_offset,text)
    SELECT ?,?,json_extract(value,'$.interval_key'),json_extract(value,'$.start_offset'),json_extract(value,'$.text') FROM json_each(?)`,
  scope_text_cursor: `INSERT INTO scope_text_progress(revision,reading_ref,cursor,raw_complete) VALUES(?,?,?,?) ON CONFLICT(revision,reading_ref) DO UPDATE SET cursor=excluded.cursor,raw_complete=excluded.raw_complete`,
  scope_text_done: `INSERT OR IGNORE INTO scope_text_complete(revision,reading_ref) VALUES(?,?)`,
  scope_normalization_next: `SELECT i.interval_key,i.start_offset,i.end_offset FROM scope_intervals i WHERE i.revision=? AND i.reading_ref=? AND NOT EXISTS (SELECT 1 FROM scope_normalized_complete c WHERE c.revision=i.revision AND c.reading_ref=i.reading_ref AND c.interval_key=i.interval_key) ORDER BY i.interval_key LIMIT 1`,
  scope_normalization_raw: `SELECT start_offset,text FROM scope_text WHERE revision=? AND reading_ref=? AND interval_key=? AND (? IS NULL OR start_offset>?) ORDER BY start_offset LIMIT 1`,
  scope_normalization_reset: `DELETE FROM scope_normalized WHERE revision=? AND reading_ref=? AND interval_key=? AND NOT EXISTS (SELECT 1 FROM scope_normalized_complete c WHERE c.revision=scope_normalized.revision AND c.reading_ref=scope_normalized.reading_ref AND c.interval_key=scope_normalized.interval_key)`,
  scope_normalized_chunks: `INSERT OR REPLACE INTO scope_normalized(revision,reading_ref,interval_key,start_offset,normalized_text,edits_json) SELECT ?,?,?,json_extract(value,'$.start_offset'),json_extract(value,'$.normalized_text'),json_extract(value,'$.edits') FROM json_each(?)`,
  scope_normalized_is_complete: `SELECT 1 AS complete FROM scope_normalized_complete WHERE revision=? AND reading_ref=? AND interval_key=?`,
  scope_normalized_coverage: `WITH chunks AS (
    SELECT start_offset,length(normalized_text) AS size,
      LAG(start_offset+length(normalized_text),1,0) OVER(ORDER BY start_offset) AS previous_end
    FROM scope_normalized WHERE revision=?1 AND reading_ref=?2 AND interval_key=?3
  ) SELECT ?4>=0 AND NOT EXISTS(SELECT 1 FROM chunks WHERE size<=0 OR start_offset<>previous_end)
    AND COALESCE((SELECT MAX(start_offset+size) FROM chunks),0)=?4 AS accepted`,
  scope_normalized_done: `INSERT OR IGNORE INTO scope_normalized_complete(revision,reading_ref,interval_key) VALUES(?,?,?)`,
  scope_revoke: `INSERT OR IGNORE INTO scope_revocations(scope_ref) SELECT value FROM json_each(?)`,
  scope_revoke_effective: `WITH requested(ref) AS (SELECT value FROM json_each(?1))
    SELECT EXISTS(SELECT 1 FROM requested q WHERE NOT EXISTS(SELECT 1 FROM scope_revocations v WHERE v.scope_ref=q.ref))
      OR EXISTS(SELECT 1 FROM scope_text WHERE reading_ref IN (SELECT ref FROM requested))
      OR EXISTS(SELECT 1 FROM scope_text_progress WHERE reading_ref IN (SELECT ref FROM requested))
      OR EXISTS(SELECT 1 FROM scope_text_complete WHERE reading_ref IN (SELECT ref FROM requested))
      OR EXISTS(SELECT 1 FROM scope_intervals WHERE reading_ref IN (SELECT ref FROM requested))
      OR EXISTS(SELECT 1 FROM scope_normalized WHERE reading_ref IN (SELECT ref FROM requested))
      OR EXISTS(SELECT 1 FROM scope_normalized_complete WHERE reading_ref IN (SELECT ref FROM requested)) AS effective`,
  scope_revoke_text: `DELETE FROM scope_text WHERE reading_ref IN (SELECT value FROM json_each(?))`,
  scope_revoke_complete: `DELETE FROM scope_text_complete WHERE reading_ref IN (SELECT value FROM json_each(?))`,
  scope_revoke_progress: `DELETE FROM scope_text_progress WHERE reading_ref IN (SELECT value FROM json_each(?))`,
  scope_revoke_normalized: `DELETE FROM scope_normalized WHERE reading_ref IN (SELECT value FROM json_each(?))`,
  scope_revoke_normalized_complete: `DELETE FROM scope_normalized_complete WHERE reading_ref IN (SELECT value FROM json_each(?))`,
  scope_revoke_intervals: `DELETE FROM scope_intervals WHERE reading_ref IN (SELECT value FROM json_each(?))`,
  scope_publish: `UPDATE scope_state SET active_revision=staging_revision,staging_revision=NULL,metadata_cursor=NULL,metadata_complete=0 WHERE singleton=1`,
  scope_readmitted: `DELETE FROM scope_revocations WHERE scope_ref IN (SELECT owner_ref FROM scope_facts WHERE kind='scope' AND revision=(SELECT active_revision FROM scope_state) UNION SELECT reading_ref FROM scope_readings WHERE revision=(SELECT active_revision FROM scope_state))`,
  scope_changed: `UPDATE replica_state SET store_revision=store_revision+1 WHERE singleton=1`,
  ...Object.fromEntries(["scope_facts", "scope_readings", "scope_intervals", "scope_text", "scope_normalized", "scope_normalized_complete", "scope_text_complete", "scope_text_progress"].map(table => [`${table}_prune`, `DELETE FROM ${table} WHERE revision IS NOT (SELECT active_revision FROM scope_state)`])),
} as const;
export interface ScopeProgress {
  active_revision: string | null; staging_revision: string | null;
  metadata_cursor: string | null; metadata_complete: boolean;
  reading_ref: string | null; text_cursor: string | null; raw_complete: boolean;
}
export interface ScopeNormalizationInterval { interval_key: string; start_offset: number; end_offset: number }
export interface ScopeRawChunk { start_offset: number; text: string }
export interface ScopeNormalizationObservation {
  progress: ScopeProgress; interval: ScopeNormalizationInterval | null; chunk: ScopeRawChunk | null;
}
export interface ScopeQuoteSlice {
  fragment_id: string; start_offset: number; text: string; start_cut: boolean; end_cut: boolean;
}
export interface NormalizedScopeQuoteSlice {
  fragment_id: string; start_offset: number; normalized_text: string;
  normalized_start_offset: number;
  edits: readonly (readonly [number, number])[]; start_cut: boolean; end_cut: boolean;
}
export interface ScopeQuoteMatch { fragment_id: string; start_offset: number; end_offset: number }
const WHITE = /[\p{White_Space}\u001c-\u001f]/u;
const MARK = /\p{M}/u;
const LEADING_WHITE = /^[\p{White_Space}\u001c-\u001f]+/u;
const TRAILING_WHITE = /[\p{White_Space}\u001c-\u001f]+$/u;
export interface NormalizedScopeChunk { normalized_text: string; start_offset: number; edits: [number, number][] }
/** Normalize an interval ONCE during hydration. NFC's final combining sequence and
 * a whitespace run remain pending across network chunks. Edits are sparse boundary
 * deltas, not a per-character map; offsets use the server's NFC source coordinates. */
export class ScopeTextNormalizer {
  private carry = "";
  private raw = 0;
  private normalized = 0;
  private delta = 0;
  private whitespace = false;
  private complete = false;
  push(text: string, final: boolean): NormalizedScopeChunk {
    if (this.complete) throw new Error("Scope interval normalization already finished");
    const chars = Array.from((this.carry + text).normalize("NFC"));
    let cut = chars.length;
    if (!final) {
      cut = chars.length - 1;
      while (cut >= 0 && MARK.test(chars[cut]!)) cut--;
      cut = Math.max(0, cut);
    }
    this.carry = chars.slice(cut).join("");
    const output: string[] = [], edits: [number, number][] = [], start_offset = this.normalized;
    const emit = (char: string) => {
      output.push(char); this.normalized++;
      const delta = this.raw - this.normalized;
      if (delta !== this.delta) { edits.push([this.normalized, delta]); this.delta = delta; }
    };
    for (let at = 0; at < cut; at++) {
      const char = chars[at]!;
      if (WHITE.test(char)) { this.raw++; this.whitespace = true; }
      else {
        if (this.whitespace) { emit(" "); this.whitespace = false; }
        this.raw++; emit(char);
      }
    }
    if (final) {
      if (this.whitespace) { emit(" "); this.whitespace = false; }
      this.complete = true;
    }
    return { normalized_text: output.join(""), start_offset, edits };
  }
}
export function normalizeScopeText(text: string): NormalizedScopeChunk { return new ScopeTextNormalizer().push(text, true); }
export function scopeRawBoundary(edits: readonly (readonly [number, number])[], at: number): number {
  let lo = 0, hi = edits.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (edits[mid]![0] <= at) lo = mid + 1; else hi = mid; }
  return at + (lo ? edits[lo - 1]![1] : 0);
}
/** Uniqueness belongs to ONE authorized reading's slices, including required notes.
 * Canonical overlaps count once; context beyond a real cut cannot disqualify a hit. */
export function matchScopeQuote(slices: Iterable<NormalizedScopeQuoteSlice>, exact: string, prefix: string, suffix: string): ScopeQuoteMatch | null {
  const scanner = new ScopeQuoteScanner(exact, prefix, suffix);
  for (const slice of slices) { scanner.add(slice); if (scanner.ambiguous) break; }
  return scanner.result;
}
/** SQL supplies only positive bounded quote windows with their real cut flags,
 * normalized base and sparse edits. Overlapping windows/notes count once. */
export class ScopeQuoteScanner {
  private readonly hits = new Map<string, ScopeQuoteMatch>();
  private readonly prefixCodepoints: number;
  private readonly suffixCodepoints: number;
  constructor(private readonly exact: string, private readonly prefix: string, private readonly suffix: string) {
    this.prefixCodepoints = Array.from(prefix).length;
    this.suffixCodepoints = Array.from(suffix).length;
  }
  get ambiguous(): boolean { return this.hits.size > 1; }
  get result(): ScopeQuoteMatch | null { return this.hits.size === 1 ? this.hits.values().next().value! : null; }
  add(slice: NormalizedScopeQuoteSlice): void {
    const { exact, prefix, suffix } = this;
    if (!exact || this.ambiguous) return;
    const normalized = { text: slice.normalized_text };
    for (let at = normalized.text.indexOf(exact); at >= 0; at = normalized.text.indexOf(exact, at + 1)) {
      const end = at + exact.length;
      const before = normalized.text.slice(0, at).replace(TRAILING_WHITE, ""), after = normalized.text.slice(end).replace(LEADING_WHITE, "");
      if (prefix && !before.endsWith(prefix) && !(slice.start_cut && Array.from(before).length < this.prefixCodepoints && prefix.endsWith(before.replace(LEADING_WHITE, "")))) continue;
      if (suffix && !after.startsWith(suffix) && !(slice.end_cut && Array.from(after).length < this.suffixCodepoints && suffix.startsWith(after.replace(TRAILING_WHITE, "")))) continue;
      const lo = Array.from(normalized.text.slice(0, at)).length, hi = lo + Array.from(exact).length;
      const match = { fragment_id: slice.fragment_id, start_offset: slice.start_offset + scopeRawBoundary(slice.edits, slice.normalized_start_offset + lo), end_offset: slice.start_offset + scopeRawBoundary(slice.edits, slice.normalized_start_offset + hi) };
      this.hits.set(JSON.stringify([match.fragment_id, match.start_offset, match.end_offset]), match);
      if (this.ambiguous) return;
    }
  }
}
/** Highlight admission uses current stored anchors, never quote relocation. */
export function highlightFitsReading(anchors: readonly ScopeQuoteMatch[], intervals: readonly ScopeInterval[]): boolean {
  if (new Set(intervals.map(interval => interval.reading_ref)).size > 1) throw new TypeError("Highlight containment requires one reading identity");
  return anchors.length > 0 && anchors.every(anchor => intervals.some(interval => interval.purpose === "body" && interval.fragment_id === anchor.fragment_id && interval.start_offset <= anchor.start_offset && anchor.end_offset <= interval.end_offset));
}
export function clippedHighlightFields(selection: { prefix: string | null; quote_exact: string; suffix: string | null }, start: number, end: number, lo: number, hi: number): { prefix: string; quote_exact: string; suffix: string } {
  const keep = Math.max(0, start - lo);
  return { prefix: keep ? Array.from(selection.prefix ?? "").slice(-keep).join("") : "", quote_exact: selection.quote_exact, suffix: Array.from(selection.suffix ?? "").slice(0, Math.max(0, hi - end)).join("") };
}
