/** Closed local reads on both SQLite hosts. Search filters requested families and
 * the complete replicated scope revision before result pagination; live authored
 * links overlay those facts. Shared quote matching and exact temporary FTS checks
 * return separate literal evidence without rewriting canonical resource content.
 * Adjacency uses the exact (position,link_id) tuple, including prefix/equal keys. */
import type { AuthoredQuery, PassageState, QueryResult, QueryRow, ResourceProjection, SelectionCapture } from "./types.ts";
import { clippedHighlightFields, highlightFitsReading, ScopeQuoteScanner, type ScopeInterval, type ScopeReading } from "./scope.ts";
export interface CompiledQuery { sql: string; params: (string | number | null)[] }
const HIGHLIGHT_TEXT_FIELDS = ["prefix", "quote_exact", "suffix"] as const;
/** Literal full capture for an all-scope excerpt; a reading scope must clip first. */
export function capturedHighlightText(selection: SelectionCapture): string {
  return HIGHLIGHT_TEXT_FIELDS.map(field => selection[field] ?? "").join("");
}
// Index fields separately so a selected word fragment remains independently searchable.
const HIGHLIGHT_SEARCH_SQL = HIGHLIGHT_TEXT_FIELDS.map(field =>
  `COALESCE(json_extract(projection_json,'$.selection.${field}'),'')`,
).join(" || ' ' || ");
export function searchExpression(text: string): string {
  return text.trim().split(/\s+/u).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}
export function adjacencyCursor(position: string, link_id: string): string {
  return JSON.stringify([position, link_id]);
}
function readAdjacencyCursor(cursor: string | null): [string, string] | null {
  if (cursor === null) return null;
  const pair: unknown = JSON.parse(cursor);
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string")) throw new TypeError("Invalid adjacency cursor");
  return [pair[0], pair[1]];
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function pageTitle(title: string, local_date: string | null): string {
  if (title) return title;
  if (local_date === null) return "untitled page";
  return `${MONTHS[Number(local_date.slice(5,7))-1]} ${Number(local_date.slice(8,10))}, ${local_date.slice(0,4)}`;
}
const DAILY_TITLE_SQL = `(CASE CAST(substr(local_date,6,2) AS INTEGER) ${MONTHS.map((month,index)=>`WHEN ${index+1} THEN '${month}'`).join(" ")} END || ' ' || CAST(CAST(substr(local_date,9,2) AS INTEGER) AS TEXT) || ', ' || substr(local_date,1,4))`;
const READABLE = `WITH readable AS (
  SELECT ref,json_set(projection_json,'$.authored_by_viewer',json('true')) AS projection_json FROM resources WHERE visible=1
  UNION ALL
  SELECT source_ref AS ref,json_object('ref',source_ref,'kind','source','authored_by_viewer',json('false'),'visible',json('true'),'body_pm_json',NULL,'body_text',NULL,'title',json_extract(state_json,'$.capture.value.label'),'local_date',NULL,'source_ref',source_ref,'selection',NULL,'color',NULL,'embedded_refs',json('[]')) AS projection_json
  FROM source_stubs WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.ref=source_stubs.source_ref) AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.anchor_id=substr(source_stubs.source_ref,16) AND source_stubs.source_ref='passage_anchor:'||p.anchor_id)
  UNION ALL
  SELECT 'passage_anchor:'||anchor_id AS ref,json_object('ref','passage_anchor:'||anchor_id,'kind','source','authored_by_viewer',json('true'),'visible',json('true'),'body_pm_json',NULL,'body_text',NULL,'title',json_extract(state_json,'$.capture.value.quote_exact'),'local_date',NULL,'source_ref',source_ref,'selection',NULL,'color',NULL,'embedded_refs',json('[]')) AS projection_json FROM passages
)`;
/** Rebuild one FTS row from canonical presented content, on either SQLite host. */
export const PAGE_TITLE_SQL = `COALESCE(NULLIF(title,''),${DAILY_TITLE_SQL},'untitled page')`;
export const SEARCH_INDEX_SQL = `${READABLE}, indexed AS (
  SELECT ref,projection_json,json_extract(projection_json,'$.kind') AS kind,
  json_extract(projection_json,'$.title') AS title,json_extract(projection_json,'$.local_date') AS local_date FROM readable
) INSERT INTO search_documents(ref,text) SELECT ref,CASE kind
  WHEN 'page' THEN COALESCE(NULLIF(title,''),${DAILY_TITLE_SQL},'untitled page')
  WHEN 'note' THEN COALESCE(json_extract(projection_json,'$.body_text'),'')
  WHEN 'highlight' THEN ${HIGHLIGHT_SEARCH_SQL}
  ELSE COALESCE(title,'') END FROM indexed WHERE ref=? ON CONFLICT(ref) DO UPDATE SET text=excluded.text WHERE search_documents.text IS NOT excluded.text`;
export const SEARCH_REMOVE_SQL = `${READABLE} DELETE FROM search_documents WHERE ref=?1 AND NOT EXISTS(SELECT 1 FROM readable WHERE readable.ref=?1)`;

function live(ref: string): string {
  return `(EXISTS(SELECT 1 FROM resources r WHERE r.ref=${ref} AND r.visible=1) OR (NOT EXISTS(SELECT 1 FROM resources r WHERE r.ref=${ref}) AND (EXISTS(SELECT 1 FROM source_stubs s WHERE s.source_ref=${ref}) OR (substr(${ref},1,15)='passage_anchor:' AND EXISTS(SELECT 1 FROM passages p WHERE p.anchor_id=substr(${ref},16))))))`;
}
const INCIDENT = `
  SELECT l.link_id,l.endpoint_a,l.endpoint_b,l.position_a AS position,l.state_json AS position_json,l.endpoint_b AS other_ref
  FROM links l INDEXED BY links_a WHERE l.endpoint_a=?1 AND l.visible=1 AND l.link_id<>COALESCE((SELECT exclude_link_id FROM bound),'') AND ${live("?1")} AND ${live("l.endpoint_b")}
  UNION ALL
  SELECT l.link_id,l.endpoint_a,l.endpoint_b,l.position_b AS position,l.state_json AS position_json,l.endpoint_a AS other_ref
  FROM links l INDEXED BY links_b WHERE l.endpoint_b=?1 AND l.visible=1 AND l.link_id<>COALESCE((SELECT exclude_link_id FROM bound),'') AND ${live("?1")} AND ${live("l.endpoint_a")}`;
const BOUNDED_READABLE = `
  SELECT r.ref,json_set(r.projection_json,'$.authored_by_viewer',json('true')) AS projection_json FROM wanted w CROSS JOIN resources r ON r.ref=w.ref WHERE r.visible=1
  UNION ALL
  SELECT s.source_ref AS ref,json_object('ref',s.source_ref,'kind','source','authored_by_viewer',json('false'),'visible',json('true'),'body_pm_json',NULL,'body_text',NULL,'title',json_extract(s.state_json,'$.capture.value.label'),'local_date',NULL,'source_ref',s.source_ref,'selection',NULL,'color',NULL,'embedded_refs',json('[]')) AS projection_json
  FROM wanted w CROSS JOIN source_stubs s ON s.source_ref=w.ref WHERE NOT EXISTS(SELECT 1 FROM resources r WHERE r.ref=w.ref) AND NOT EXISTS(SELECT 1 FROM passages p WHERE p.anchor_id=substr(w.ref,16) AND w.ref='passage_anchor:'||p.anchor_id)
  UNION ALL
  SELECT 'passage_anchor:'||p.anchor_id AS ref,json_object('ref','passage_anchor:'||p.anchor_id,'kind','source','authored_by_viewer',json('true'),'visible',json('true'),'body_pm_json',NULL,'body_text',NULL,'title',json_extract(p.state_json,'$.capture.value.quote_exact'),'local_date',NULL,'source_ref',p.source_ref,'selection',NULL,'color',NULL,'embedded_refs',json('[]')) AS projection_json
  FROM wanted w CROSS JOIN passages p ON p.anchor_id=substr(w.ref,16) WHERE w.ref='passage_anchor:'||p.anchor_id`;
const SEARCH_FAMILY = `CASE substr(d.ref,1,instr(d.ref,':')-1)
  WHEN 'note_block' THEN 'notes' WHEN 'page' THEN 'notes' WHEN 'highlight' THEN 'highlights'
  WHEN 'passage_anchor' THEN 'saved_passages' WHEN 'media' THEN 'documents' WHEN 'podcast' THEN 'documents'
  WHEN 'conversation' THEN 'conversations' WHEN 'contributor' THEN 'people'
  WHEN 'library' THEN 'libraries' WHEN 'oracle_reading' THEN 'readings' END`;
const SEARCH_SQL = `WITH wanted AS MATERIALIZED(
  SELECT d.ref FROM search_fts f CROSS JOIN search_documents d ON d.rowid=f.rowid
  WHERE search_fts MATCH ?1 AND (?2 IS NULL OR ${SEARCH_FAMILY} IN (SELECT value FROM json_each(?2)))
    AND d.ref>?3 ORDER BY d.ref LIMIT ?4
),readable AS NOT MATERIALIZED(${BOUNDED_READABLE}) SELECT projection_json,NULL AS link_json FROM readable ORDER BY ref`;
const SEARCH_SCOPE_CTES = `requested(scope_ref) AS (SELECT value FROM json_each(?1)),
  revision(value) AS (SELECT active_revision FROM scope_state WHERE singleton=1),
  facts AS MATERIALIZED(
    SELECT f.owner_ref,f.target_ref FROM requested q JOIN scope_facts f ON f.owner_ref=q.scope_ref
    WHERE f.revision=(SELECT value FROM revision) AND f.kind='conversation_fact'
    UNION
    SELECT q.scope_ref,CASE WHEN l.endpoint_a=q.scope_ref THEN l.endpoint_b ELSE l.endpoint_a END
    FROM requested q JOIN links l ON l.endpoint_a=q.scope_ref OR l.endpoint_b=q.scope_ref
    WHERE substr(q.scope_ref,1,13)='conversation:' AND l.visible=1 AND ${live("l.endpoint_a")} AND ${live("l.endpoint_b")}
  ),reading_targets AS (
    SELECT f.owner_ref,f.target_ref FROM requested q JOIN scope_facts f ON f.owner_ref=q.scope_ref
    WHERE f.revision=(SELECT value FROM revision) AND f.kind IN ('media_member','library_member')
    UNION SELECT owner_ref,target_ref FROM facts
  ),
  members AS MATERIALIZED(
    SELECT DISTINCT f.owner_ref,r.* FROM reading_targets f
    JOIN scope_readings r ON r.revision=(SELECT value FROM revision) AND r.reading_ref=f.target_ref
    WHERE NOT EXISTS(SELECT 1 FROM scope_revocations v WHERE v.scope_ref=r.reading_ref)
  )`;
const SEARCH_SCOPE_AVAILABLE_SQL = `WITH ${SEARCH_SCOPE_CTES}
  SELECT active_revision AS revision,active_revision IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM requested q WHERE EXISTS(SELECT 1 FROM scope_revocations v WHERE v.scope_ref=q.scope_ref)
      OR NOT EXISTS(SELECT 1 FROM scope_facts f WHERE f.revision=active_revision AND f.kind='scope' AND f.owner_ref=q.scope_ref)
  ) AND NOT EXISTS(
    SELECT 1 FROM members r WHERE r.reading_ref<>r.source_ref AND (r.body_generation IS NULL OR r.source_generation IS NULL)
  ) AS available FROM scope_state WHERE singleton=1`;
const SEARCH_SCOPED_SQL = `WITH ${SEARCH_SCOPE_CTES},
  scope_highlights(ref) AS NOT MATERIALIZED(
    SELECT h.ref FROM resources h WHERE h.kind='highlight' AND h.visible=1 AND (
      h.ref IN (SELECT target_ref FROM facts) OR EXISTS(SELECT 1 FROM members m WHERE h.source_ref IN (m.reading_ref,m.source_ref)))
  ),linked_notes(ref) AS NOT MATERIALIZED(
    SELECT n.ref FROM resources n JOIN links l ON (l.endpoint_a=n.ref OR l.endpoint_b=n.ref)
    WHERE n.kind IN ('note','page') AND n.visible=1 AND l.visible=1 AND ${live("l.endpoint_a")} AND ${live("l.endpoint_b")}
      AND (CASE WHEN l.endpoint_a=n.ref THEN l.endpoint_b ELSE l.endpoint_a END IN (
        SELECT reading_ref FROM members WHERE substr(owner_ref,1,13)<>'conversation:'
        UNION SELECT peer.owner_ref FROM scope_facts peer JOIN members m ON m.reading_ref=peer.target_ref
          WHERE peer.revision=(SELECT value FROM revision) AND peer.kind='highlight_member' AND substr(m.owner_ref,1,13)<>'conversation:'
        UNION SELECT h.ref FROM scope_highlights h JOIN resources r ON r.ref=h.ref
          WHERE EXISTS(SELECT 1 FROM members m WHERE substr(m.owner_ref,1,13)<>'conversation:' AND r.source_ref IN (m.reading_ref,m.source_ref))))
  ),scope_refs(ref) AS NOT MATERIALIZED(
    SELECT ref FROM scope_highlights UNION SELECT ref FROM linked_notes
    UNION SELECT r.ref FROM resources r WHERE r.visible=1 AND r.kind IN ('note','page') AND r.ref IN (SELECT target_ref FROM facts)
    UNION SELECT 'passage_anchor:'||p.anchor_id FROM passages p WHERE p.source_ref IN (SELECT ref FROM linked_notes)
      OR 'passage_anchor:'||p.anchor_id IN (SELECT target_ref FROM facts)
      OR EXISTS(SELECT 1 FROM members m WHERE p.source_ref IN (m.reading_ref,m.source_ref)
        OR EXISTS(SELECT 1 FROM scope_facts owner WHERE owner.revision=m.revision AND owner.kind='source_alias' AND owner.owner_ref=p.source_ref AND owner.target_ref=m.source_ref))
  ),wanted AS MATERIALIZED(
    SELECT d.ref FROM search_fts f CROSS JOIN search_documents d ON d.rowid=f.rowid
    WHERE search_fts MATCH ?2 AND (?3 IS NULL OR ${SEARCH_FAMILY} IN (SELECT value FROM json_each(?3)))
      AND EXISTS(SELECT 1 FROM scope_refs scoped WHERE scoped.ref=d.ref) AND d.ref>?4 ORDER BY d.ref LIMIT ?5
  ),readable AS NOT MATERIALIZED(${BOUNDED_READABLE})
  SELECT r.projection_json,NULL AS link_json,p.state_json AS passage_json FROM readable r
  LEFT JOIN passages p ON r.ref='passage_anchor:'||p.anchor_id ORDER BY r.ref`;
const SEARCH_LINKS_SQL = `WITH ${SEARCH_SCOPE_CTES},wanted(ref) AS (SELECT value FROM json_each(?2)),peers AS (
  SELECT w.ref AS owner_ref,CASE WHEN l.endpoint_a=w.ref THEN l.endpoint_b ELSE l.endpoint_a END AS ref
  FROM wanted w JOIN links l ON l.endpoint_a=w.ref OR l.endpoint_b=w.ref
  LEFT JOIN resources h ON h.ref=CASE WHEN l.endpoint_a=w.ref THEN l.endpoint_b ELSE l.endpoint_a END AND h.kind='highlight' AND h.visible=1
  WHERE l.visible=1 AND ${live("l.endpoint_a")} AND ${live("l.endpoint_b")}
    AND (EXISTS(SELECT 1 FROM members m WHERE substr(m.owner_ref,1,13)<>'conversation:'
      AND (m.reading_ref=CASE WHEN l.endpoint_a=w.ref THEN l.endpoint_b ELSE l.endpoint_a END OR h.source_ref IN (m.reading_ref,m.source_ref)))
      OR EXISTS(SELECT 1 FROM scope_facts peer JOIN members m ON m.reading_ref=peer.target_ref
        WHERE peer.revision=(SELECT value FROM revision) AND peer.kind='highlight_member' AND substr(m.owner_ref,1,13)<>'conversation:'
          AND peer.owner_ref=CASE WHEN l.endpoint_a=w.ref THEN l.endpoint_b ELSE l.endpoint_a END))
) SELECT p.owner_ref,p.ref,r.projection_json,
  EXISTS(SELECT 1 FROM scope_facts peer JOIN members m ON m.reading_ref=peer.target_ref
    WHERE peer.revision=(SELECT value FROM revision) AND peer.kind='highlight_member' AND substr(m.owner_ref,1,13)<>'conversation:' AND peer.owner_ref=p.ref) AS external_member,
  json_array(p.owner_ref,p.ref) AS cursor_json FROM peers p
  LEFT JOIN resources r ON r.ref=p.ref AND r.visible=1 AND r.kind='highlight'
  WHERE (p.owner_ref,p.ref)>(COALESCE(json_extract(?3,'$[0]'),''),COALESCE(json_extract(?3,'$[1]'),''))
  ORDER BY p.owner_ref,p.ref LIMIT 100`;
const SEARCH_READINGS_SQL = `WITH ${SEARCH_SCOPE_CTES}
  SELECT m.reading_ref,m.source_ref,m.source_kind,m.body_generation,m.source_generation,
    MAX(substr(m.owner_ref,1,13)<>'conversation:') AS linked_allowed,
    EXISTS(SELECT 1 FROM scope_text_complete c WHERE c.revision=m.revision AND c.reading_ref=m.reading_ref) AS complete,
    json_quote(m.reading_ref) AS cursor_json
  FROM members m WHERE m.reading_ref IN (SELECT value FROM json_each(?2)) OR (
    (m.source_ref IN (SELECT value FROM json_each(?2)) OR EXISTS(SELECT 1 FROM scope_facts owner WHERE owner.revision=m.revision AND owner.kind='source_alias' AND owner.owner_ref IN (SELECT value FROM json_each(?2)) AND owner.target_ref=m.source_ref))
    AND (m.reading_ref=m.source_ref OR NOT EXISTS(SELECT 1 FROM members root WHERE root.reading_ref=m.source_ref)))
  GROUP BY m.reading_ref HAVING m.reading_ref>COALESCE(json_extract(?3,'$'),'') ORDER BY m.reading_ref LIMIT 100`;
const SEARCH_INTERVALS_SQL = `SELECT interval_key,reading_ref,fragment_id,fragment_idx,start_offset,end_offset,purpose,start_cut,end_cut
    ,json_array(reading_ref,interval_key) AS cursor_json
  FROM scope_intervals WHERE revision=(SELECT active_revision FROM scope_state WHERE singleton=1)
    AND reading_ref IN (SELECT value FROM json_each(?1))
    AND (reading_ref,interval_key)>(COALESCE(json_extract(?2,'$[0]'),''),COALESCE(json_extract(?2,'$[1]'),''))
  ORDER BY reading_ref,interval_key LIMIT 100`;
const SEARCH_FACTS_SQL = `WITH ${SEARCH_SCOPE_CTES} SELECT DISTINCT target_ref FROM facts WHERE target_ref IN (SELECT value FROM json_each(?2))`;
const SEARCH_ALIASES_SQL = `SELECT owner_ref,target_ref FROM scope_facts
  WHERE revision=(SELECT active_revision FROM scope_state WHERE singleton=1) AND kind='source_alias'
    AND owner_ref IN (SELECT value FROM json_each(?1))`;
const SEARCH_RESOURCES_SQL = `SELECT ref,visible FROM resources WHERE kind='note' AND ref IN (SELECT value FROM json_each(?1)) ORDER BY ref`;
// Pick one positive window by its small cursor metadata before projecting text.
// The candidate scan may visit the reading, but never retains every overlap blob.
const SEARCH_QUOTE_WINDOWS_SQL = `WITH windows AS NOT MATERIALIZED(
  SELECT n.interval_key,n.start_offset AS chunk_start,i.fragment_id,i.start_offset AS raw_start,
    MAX(0,n.start_offset-length(?3)-1) AS lo,
    MIN(n.start_offset+length(n.normalized_text)+length(?2)+length(?4)+1,
      (SELECT tail.start_offset+length(tail.normalized_text) FROM scope_normalized tail
        WHERE tail.revision=n.revision AND tail.reading_ref=n.reading_ref AND tail.interval_key=n.interval_key ORDER BY tail.start_offset DESC LIMIT 1)) AS hi,
    i.start_cut,i.end_cut,n.revision,n.reading_ref,
    (SELECT tail.start_offset+length(tail.normalized_text) FROM scope_normalized tail
      WHERE tail.revision=n.revision AND tail.reading_ref=n.reading_ref AND tail.interval_key=n.interval_key ORDER BY tail.start_offset DESC LIMIT 1) AS total
  FROM scope_normalized n CROSS JOIN scope_intervals i ON i.revision=n.revision AND i.reading_ref=n.reading_ref AND i.interval_key=n.interval_key
  WHERE n.revision=(SELECT active_revision FROM scope_state WHERE singleton=1) AND n.reading_ref=?1
    AND (n.interval_key,n.start_offset)>(COALESCE(json_extract(?5,'$[0]'),''),COALESCE(json_extract(?5,'$[1]'),-1))
),selected AS MATERIALIZED(
  SELECT w.* FROM windows w WHERE instr((SELECT group_concat(piece,'') FROM (
    SELECT substr(c.normalized_text,MAX(w.lo-c.start_offset,0)+1,MIN(c.start_offset+length(c.normalized_text),w.hi)-MAX(c.start_offset,w.lo)) AS piece
    FROM scope_normalized c WHERE c.revision=w.revision AND c.reading_ref=w.reading_ref AND c.interval_key=w.interval_key
      AND c.start_offset>=COALESCE((SELECT MAX(first.start_offset) FROM scope_normalized first
        WHERE first.revision=w.revision AND first.reading_ref=w.reading_ref AND first.interval_key=w.interval_key AND first.start_offset<=w.lo),0)
      AND c.start_offset<w.hi ORDER BY c.start_offset
  )),?2)>0 ORDER BY w.interval_key,w.chunk_start LIMIT 1
),proved AS MATERIALIZED(
  SELECT s.*,(SELECT MAX(json_extract(prior.value,'$[0]')) FROM scope_normalized p,json_each(p.edits_json) prior
    WHERE p.revision=s.revision AND p.reading_ref=s.reading_ref AND p.interval_key=s.interval_key
      AND p.start_offset<=s.lo AND json_extract(prior.value,'$[0]')<s.lo) AS edit_before FROM selected s
)
SELECT t.interval_key,t.chunk_start,t.fragment_id,t.raw_start,t.lo,
  (SELECT group_concat(piece,'') FROM (
    SELECT substr(c.normalized_text,MAX(t.lo-c.start_offset,0)+1,MIN(c.start_offset+length(c.normalized_text),t.hi)-MAX(c.start_offset,t.lo)) AS piece
    FROM scope_normalized c WHERE c.revision=t.revision AND c.reading_ref=t.reading_ref AND c.interval_key=t.interval_key
      AND c.start_offset>=COALESCE((SELECT MAX(first.start_offset) FROM scope_normalized first
        WHERE first.revision=t.revision AND first.reading_ref=t.reading_ref AND first.interval_key=t.interval_key AND first.start_offset<=t.lo),0)
      AND c.start_offset<t.hi ORDER BY c.start_offset
  )) AS normalized_text,
  t.lo=0 AND t.start_cut AS start_cut,t.hi=t.total AND t.end_cut AS end_cut,
  (SELECT json_group_array(json(value)) FROM (
    SELECT e.value FROM scope_normalized c,json_each(c.edits_json) e
    WHERE c.revision=t.revision AND c.reading_ref=t.reading_ref AND c.interval_key=t.interval_key
      AND c.start_offset<=t.hi
      AND (json_extract(e.value,'$[0]') BETWEEN t.lo AND t.hi OR json_extract(e.value,'$[0]')=t.edit_before)
    ORDER BY json_extract(e.value,'$[0]')
  )) AS edits_json,json_array(t.interval_key,t.chunk_start) AS cursor_json
FROM proved t`;

/** Fixed host-local lexical evaluation; the single temporary row is never corpus
 * state and is cleared by the serialized query owner before and after use. */
export const SEARCH_MATCH_SQL = {
  search_match_create: `CREATE VIRTUAL TABLE IF NOT EXISTS temp.scope_search_match USING fts5(text,tokenize='unicode61 remove_diacritics 2')`,
  search_match_clear: `DELETE FROM temp.scope_search_match`,
  search_match_insert: `INSERT INTO temp.scope_search_match(text) VALUES(?)`,
  search_match_read: `SELECT 1 AS matched FROM temp.scope_search_match WHERE scope_search_match MATCH ? LIMIT 1`,
} as const;
/** Every read shape is finite and packaged by content identity for the native host. */
export const SEARCH_READ_SQL = [SEARCH_SQL, SEARCH_SCOPE_AVAILABLE_SQL, SEARCH_SCOPED_SQL, SEARCH_LINKS_SQL,
  SEARCH_READINGS_SQL, SEARCH_INTERVALS_SQL, SEARCH_FACTS_SQL, SEARCH_ALIASES_SQL, SEARCH_RESOURCES_SQL, SEARCH_QUOTE_WINDOWS_SQL] as const;
/** Each endpoint arm is an ordered index range with its own bound. The outer
 * merge sees at most twice the requested rows, including sparse live endpoints. */
function orderedIncident(where:string,direction:"ASC"|"DESC",limit:string,exclude:string,requireRootLive=true):string {
  return (["a","b"] as const).map(side=>{
    const other=side==="a"?"b":"a";
    const condition=where.replaceAll("POSITION",`l.position_${side}`);
    return `SELECT * FROM(SELECT l.link_id,l.endpoint_a,l.endpoint_b,l.position_${side} AS position,l.state_json AS position_json,l.endpoint_${other} AS other_ref FROM links l INDEXED BY links_${side} WHERE l.endpoint_${side}=?1 AND l.visible=1 AND l.link_id<>COALESCE(${exclude},'') AND ${requireRootLive?live("?1"):"1"} AND ${live(`l.endpoint_${other}`)} ${condition} ORDER BY l.position_${side} ${direction},l.link_id ${direction} LIMIT ${limit})`;
  }).join(" UNION ALL ");
}
function anchor(parameter:string,requireLive=true):string {
  return `SELECT link_id,CASE WHEN endpoint_a=?1 THEN position_a ELSE position_b END AS position FROM links WHERE link_id=${parameter} ${requireLive?"AND visible=1":""} AND(endpoint_a=?1 OR endpoint_b=?1)`;
}
function positions(query: Extract<AuthoredQuery,{kind:"positions"}>):CompiledQuery {
  const params:(string|number|null)[]=[query.ref,query.exclude_link_id];
  const at=query.at;
  if(at.kind==="tail")return {sql:`WITH selected AS(${orderedIncident("","DESC","1","?2",false)}) SELECT position_json FROM selected ORDER BY position DESC,link_id DESC LIMIT 1`,params};
  if(at.kind==="tie")return {sql:`WITH selected AS(${orderedIncident("AND POSITION=?3 AND l.link_id>?4","ASC","?5","?2",false)}) SELECT position_json,link_id AS cursor_json FROM selected ORDER BY position,link_id LIMIT ?5`,params:[...params,at.position,at.cursor??"",Math.max(1,Math.min(100,Math.floor(at.limit)))]};
  if(at.kind==="bounds")return {sql:`WITH lo AS(${orderedIncident("AND POSITION<?3","DESC","1","?2",false)}),hi AS(${orderedIncident("AND POSITION>?3","ASC","1","?2",false)}),first AS(SELECT * FROM lo ORDER BY position DESC,link_id DESC LIMIT 1),last AS(SELECT * FROM hi ORDER BY position,link_id LIMIT 1) SELECT position_json FROM(SELECT * FROM first UNION ALL SELECT * FROM last) ORDER BY position,link_id`,params:[...params,at.position]};
  const direction=at.side==="before"?"DESC":"ASC",comparison=at.side==="before"?"<":">";
  return {sql:`WITH anchor AS MATERIALIZED(${anchor("?3")}),neighbors AS(${orderedIncident(`AND(POSITION,l.link_id)${comparison}((SELECT position FROM anchor),(SELECT link_id FROM anchor))`,direction,"1","?2",false)}),nearest AS(SELECT * FROM neighbors ORDER BY position ${direction},link_id ${direction} LIMIT 1),selected AS(SELECT l.state_json AS position_json,CASE WHEN l.endpoint_a=?1 THEN l.position_a ELSE l.position_b END AS position,l.link_id FROM links l WHERE l.link_id=?3 AND EXISTS(SELECT 1 FROM anchor) UNION ALL SELECT position_json,position,link_id FROM nearest) SELECT position_json FROM selected ORDER BY position,link_id`,params:[...params,at.link_id]};
}

export function compileQuery(query: AuthoredQuery): CompiledQuery {
  const limit = "limit" in query ? Math.max(1, Math.min(100, Math.floor(query.limit))) : 100;
  switch (query.kind) {
    case "outline_children": {
      if(query.occurrences.length>100||query.occurrences.some(item=>item.refs.length>2||item.excluded_link_ids.length>1000))throw new RangeError("Child occurrence batch exceeds bound");
      const eligible=(["a","b"] as const).map(side=>{const other=side==="a"?"b":"a";return `EXISTS(SELECT 1 FROM links l INDEXED BY links_${side} WHERE l.endpoint_${side}=endpoint.value AND l.visible=1 AND ${live("endpoint.value")} AND ${live(`l.endpoint_${other}`)} AND NOT EXISTS(SELECT 1 FROM json_each(occurrence.value,'$.excluded_link_ids') excluded WHERE excluded.value=l.link_id))`;}).join(" OR ");
      return {sql:`SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(occurrence.value,'$.refs') endpoint WHERE ${live("endpoint.value")}) THEN EXISTS(SELECT 1 FROM json_each(occurrence.value,'$.refs') endpoint WHERE ${eligible}) ELSE NULL END AS child_available FROM json_each(?) occurrence ORDER BY CAST(occurrence.key AS INTEGER)`,params:[JSON.stringify(query.occurrences)]};
    }
    case "positions":return positions(query);
    case "binding": {
      const key = query.key;
      if (key.kind === "daily") return { sql: "SELECT ref AS binding_id FROM resources WHERE local_date=?", params: [key.local_date] };
      if (key.kind === "link") return { sql: "SELECT link_id AS binding_id FROM links WHERE endpoint_a=? AND endpoint_b=?", params: [key.endpoint_a, key.endpoint_b] };
      return { sql: "SELECT anchor_id AS binding_id FROM passages WHERE source_ref=? AND json_extract(state_json,'$.normalized_exact')=? AND json_extract(state_json,'$.prefix')=? AND json_extract(state_json,'$.suffix')=?", params: [key.source_ref, key.normalized_exact, key.prefix, key.suffix] };
    }
    case "resource": return { sql: `${READABLE} SELECT projection_json,NULL AS link_json FROM readable WHERE ref=?`, params: [query.ref] };
    case "resolve": {
      if (query.refs.length > 100) throw new TypeError("At most 100 references may be resolved");
      return { sql: `${READABLE} SELECT projection_json,NULL AS link_json FROM readable WHERE ref IN (${query.refs.map(() => "?").join(",") || "NULL"}) ORDER BY ref`, params: query.refs };
    }
    case "daily": return { sql: "SELECT json_set(projection_json,'$.authored_by_viewer',json('true')) AS projection_json,NULL AS link_json FROM resources WHERE local_date=? AND visible=1", params: [query.local_date] };
    case "pages": {
      const cursor=readAdjacencyCursor(query.cursor);
      const where=cursor===null?'':`WHERE(display_title,ref)>(?,?)`;
      return {sql:`WITH pages AS(SELECT json_set(projection_json,'$.authored_by_viewer',json('true')) AS projection_json,ref,${PAGE_TITLE_SQL} AS display_title FROM resources WHERE kind='page' AND visible=1) SELECT projection_json,NULL AS link_json,json_array(display_title,ref) AS cursor_json FROM pages ${where} ORDER BY display_title,ref LIMIT ?`,params:[...cursor?[cursor[0],cursor[1]]:[],limit]};
    }
    case "annotation_notes": {
      let cursor: [string,string,string] | null = null;
      if (query.cursor !== null) {
        const value: unknown = JSON.parse(query.cursor);
        if (!Array.isArray(value) || value.length !== 3 || value.some(item=>typeof item!=="string")) throw new TypeError("Invalid annotation note cursor");
        cursor=[value[0],value[1],value[2]];
      }
      return {
        sql: `WITH attached AS (
          SELECT json_set(n.projection_json,'$.authored_by_viewer',json('true')) AS projection_json,l.state_json AS link_json,h.ref AS highlight_ref,l.link_id,
          CASE WHEN l.endpoint_a=h.ref THEN l.position_a ELSE l.position_b END AS position
          FROM resources h JOIN links l ON (l.endpoint_a=h.ref OR l.endpoint_b=h.ref)
          JOIN resources n ON n.ref=CASE WHEN l.endpoint_a=h.ref THEN l.endpoint_b ELSE l.endpoint_a END
          WHERE h.kind='highlight' AND h.source_ref=? AND h.visible=1 AND l.visible=1 AND n.kind='note' AND n.visible=1
        ) SELECT projection_json,link_json,json_array(highlight_ref,position,link_id) AS cursor_json FROM attached WHERE (? IS NULL OR highlight_ref>? OR (highlight_ref=? AND (position>? OR(position=? AND link_id>?)))) ORDER BY highlight_ref,position,link_id LIMIT ?`,
        params:[query.source_ref,cursor?.[0]??null,cursor?.[0]??"",cursor?.[0]??"",cursor?.[1]??"",cursor?.[1]??"",cursor?.[2]??"",limit],
      };
    }
    case "annotations": return { sql: "SELECT json_set(projection_json,'$.authored_by_viewer',json('true')) AS projection_json,NULL AS link_json FROM resources WHERE kind='highlight' AND visible=1 AND source_ref=? AND ref>? ORDER BY ref LIMIT ?", params: [query.source_ref, query.cursor ?? "", limit] };
    case "backlinks": return { sql: "SELECT json_set(r.projection_json,'$.authored_by_viewer',json('true')) AS projection_json,NULL AS link_json FROM reference_index i JOIN resources r ON r.ref=i.owner_ref WHERE i.target_ref=? AND r.visible=1 AND r.ref>? ORDER BY r.ref LIMIT ?", params: [query.ref, query.cursor ?? "", limit] };
    case "search": return { sql: SEARCH_SQL, params: [searchExpression(query.text) || '""', query.families === null ? null : JSON.stringify(query.families), query.cursor ?? "", limit] };
    case "adjacency": {
      const cursor=readAdjacencyCursor(query.cursor);
      const where=cursor===null?'':`WHERE (position,link_id)>(?,?)`;
      return {sql:`WITH bound(ref,exclude_link_id) AS (VALUES(?,NULL)),incident AS NOT MATERIALIZED (${INCIDENT}),selected AS MATERIALIZED (SELECT * FROM incident ${where} ORDER BY position,link_id LIMIT ?),wanted(ref) AS (SELECT other_ref FROM selected),readable AS NOT MATERIALIZED (${BOUNDED_READABLE}) SELECT r.projection_json,s.position_json AS link_json,json_array(s.position,s.link_id) AS cursor_json FROM selected s JOIN readable r ON r.ref=s.other_ref ORDER BY s.position,s.link_id`,params:[query.ref,...cursor?[cursor[0],cursor[1]]:[],limit]};
    }
    case "adjacency_window": {
      // Removing the focused relationship retains its place among live neighbors.
      const cursor=readAdjacencyCursor(query.cursor);
      if(cursor!==null)return compileQuery({kind:'adjacency',ref:query.ref,cursor:query.cursor,limit});
      const before=Math.floor(limit/2),after=limit-before;
      const earlier=orderedIncident("AND(POSITION,l.link_id)<((SELECT position FROM anchor),(SELECT link_id FROM anchor))","DESC","?3","NULL");
      const later=orderedIncident("AND(POSITION,l.link_id)>=((SELECT position FROM anchor),(SELECT link_id FROM anchor))","ASC","?4","NULL");
      const previous=orderedIncident("AND(POSITION,l.link_id)<((SELECT position FROM first),(SELECT link_id FROM first))","DESC","1","NULL");
      return {sql:`WITH anchor AS MATERIALIZED(${anchor("?2",false)}),before_candidates AS(${earlier}),after_candidates AS(${later}),earlier AS(SELECT * FROM before_candidates ORDER BY position DESC,link_id DESC LIMIT ?3),later AS(SELECT * FROM after_candidates ORDER BY position,link_id LIMIT ?4),selected AS MATERIALIZED(SELECT * FROM earlier UNION ALL SELECT * FROM later),first AS(SELECT position,link_id FROM selected ORDER BY position,link_id LIMIT 1),previous_candidates AS(${previous}),wanted(ref) AS(SELECT other_ref FROM selected),readable AS NOT MATERIALIZED(${BOUNDED_READABLE}) SELECT r.projection_json,s.position_json AS link_json,json_array(s.position,s.link_id) AS cursor_json,CASE WHEN EXISTS(SELECT 1 FROM previous_candidates) THEN (SELECT link_id FROM first) ELSE NULL END AS previous_cursor FROM selected s JOIN readable r ON r.ref=s.other_ref ORDER BY s.position,s.link_id`,params:[query.ref,query.link_id,before,after]};
    }
  }
}

type SearchRead = (plan: CompiledQuery) => Promise<Record<string, unknown>[]>;
type SearchReading = ScopeReading & { linked_allowed: boolean; intervals: ScopeInterval[] };
type SearchText = { literal: string; lexical: string };

/** Both serialized hosts execute this same bounded search. SQL filters the family
 * and broad graph scope before candidate paging. Canonical containment, normalized
 * quote uniqueness and clipped FTS matching precede the requested result limit.
 * Only positive bounded quote windows cross the storage boundary; source text and
 * derived scope inputs never replace the canonical authored projection. */
export async function searchQuery(read: SearchRead, query: Extract<AuthoredQuery, {kind: "search"}>,
  matches: (text: string, expression: string) => Promise<boolean>): Promise<Omit<QueryResult, "store_revision">> {
  const result: Omit<QueryResult, "store_revision"> = {rows: [], next_cursor: null, previous_cursor: null, binding_id: null, positions: [], children: [], scope_available: true};
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit)));
  const scopeRefs = query.scopes.flatMap(scope => scope.kind === "all" ? [] : [`${scope.kind}:${scope.id}`]);
  const scopesJson = JSON.stringify(scopeRefs);
  if (!query.scopes.length) return {...result, scope_available: false};
  if (query.scopes.some(scope => scope.kind === "all")) {
    const raw = await read(compileQuery(query));
    result.rows = raw.map(row => ({resource: JSON.parse(String(row.projection_json)), link: null, match_text: null}));
    if (result.rows.length === limit) result.next_cursor = result.rows.at(-1)!.resource.ref;
    return result;
  }
  const available = await read({sql: SEARCH_SCOPE_AVAILABLE_SQL, params: [scopesJson]});
  if (Number(available[0]?.available) !== 1) return {...result, scope_available: false};
  const expression = searchExpression(query.text) || '""';
  const readings = new Map<string, SearchReading>();
  const loadedSources = new Set<string>();
  const sourceNotes = new Map<string, boolean>();
  const peers = new Map<string, {ref: string; resource: ResourceProjection | null; scoped: boolean}[]>();
  const aliases = new Map<string, string>();
  const highlightTexts = new Map<string, SearchText[]>();
  const passageMembership = new Map<string, boolean>();
  const directFacts = new Set<string>();
  const pageRead = async (sql: string, params: CompiledQuery["params"]) => {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await read({sql, params: [...params, cursor]});
      rows.push(...page);
      if (page.length < 100) return rows;
      cursor = String(page.at(-1)!.cursor_json);
    }
  };
  const textsForHighlight = (resource: ResourceProjection, linkedOnly: boolean): SearchText[] => {
    const key = `${resource.ref}:${linkedOnly}`;
    const known = highlightTexts.get(key);
    if (known) return known;
    const selection = resource.selection;
    if (!selection) return [];
    const variants: SearchText[] = [];
    const full = () => ({literal: capturedHighlightText(selection), lexical: HIGHLIGHT_TEXT_FIELDS.map(field => selection[field] ?? "").join(" ")});
    if (!linkedOnly && directFacts.has(resource.ref)) variants.push(full());
    for (const reading of readings.values()) {
      if (linkedOnly && !reading.linked_allowed) continue;
      if (reading.reading_ref === resource.source_ref) {variants.push(full()); continue;}
      if (reading.source_ref !== resource.source_ref || selection.locator.type === "pdf_page_geometry") continue;
      const locator = selection.locator;
      if (!highlightFitsReading([{fragment_id: locator.fragment_id, start_offset: locator.start_offset, end_offset: locator.end_offset}], reading.intervals)) continue;
      const intervals = reading.intervals.filter(interval => interval.purpose === "body" && interval.fragment_id === locator.fragment_id);
      const fields = clippedHighlightFields(selection, locator.start_offset, locator.end_offset,
        Math.min(...intervals.map(interval => interval.start_offset)), Math.max(...intervals.map(interval => interval.end_offset)));
      variants.push({literal: HIGHLIGHT_TEXT_FIELDS.map(field => fields[field]).join(""), lexical: HIGHLIGHT_TEXT_FIELDS.map(field => fields[field]).join(" ")});
    }
    highlightTexts.set(key, variants);
    return variants;
  };
  const noteInScope = (ref: string): boolean => directFacts.has(ref) || (peers.get(ref) ?? []).some(peer =>
    peer.scoped || [...readings.values()].some(reading => reading.linked_allowed && reading.reading_ref === peer.ref)
      || peer.resource?.kind === "highlight" && textsForHighlight(peer.resource, true).length > 0);
  const passageInScope = async (passage: PassageState, ref: string): Promise<boolean> => {
    const known = passageMembership.get(ref);
    if (known !== undefined) return known;
    let admitted = false;
    if (passage.source_ref.startsWith("note_block:")) admitted = sourceNotes.has(passage.source_ref)
      && (directFacts.has(ref) || sourceNotes.get(passage.source_ref) === true && noteInScope(passage.source_ref));
    else {
      const source = aliases.get(passage.source_ref) ?? passage.source_ref;
      for (const reading of readings.values()) {
        if (reading.source_ref !== source && reading.reading_ref !== source) continue;
        // An admitted full source retains its stored quote even when unlocated.
        if (reading.reading_ref === reading.source_ref) {admitted = true; break;}
        const scanner = new ScopeQuoteScanner(passage.normalized_exact, passage.prefix, passage.suffix);
        let cursor: string | null = null;
        for (;;) {
          const windows = await read({sql: SEARCH_QUOTE_WINDOWS_SQL, params: [reading.reading_ref, passage.normalized_exact, passage.prefix, passage.suffix, cursor]});
          if (!windows.length) break;
          const window = windows[0]!;
          scanner.add({fragment_id: String(window.fragment_id), start_offset: Number(window.raw_start), normalized_start_offset: Number(window.lo),
            normalized_text: String(window.normalized_text), edits: JSON.parse(String(window.edits_json)), start_cut: Number(window.start_cut) === 1, end_cut: Number(window.end_cut) === 1});
          if (scanner.ambiguous) break;
          cursor = String(window.cursor_json);
        }
        if (scanner.result !== null) {admitted = true; break;}
      }
    }
    passageMembership.set(ref, admitted);
    return admitted;
  };
  let cursor = query.cursor ?? "";
  for (;;) {
    const raw = await read({sql: SEARCH_SCOPED_SQL, params: [scopesJson, expression, query.families === null ? null : JSON.stringify(query.families), cursor, 100]});
    if (!raw.length) return result;
    const candidates = raw.map(row => {
      const resource: ResourceProjection = JSON.parse(String(row.projection_json));
      const passage: PassageState | null = row.passage_json === null ? null : JSON.parse(String(row.passage_json));
      if (resource.kind === "note") sourceNotes.set(resource.ref, resource.visible);
      return {resource, passage};
    });
    const noteRefs = [...new Set(candidates.flatMap(({resource, passage}) => resource.kind === "note" || resource.kind === "page" ? [resource.ref]
      : passage?.source_ref.startsWith("note_block:") ? [passage.source_ref] : []))];
    const missingNotes = noteRefs.filter(ref => !peers.has(ref));
    if (missingNotes.length) {
      for (const ref of missingNotes) peers.set(ref, []);
      if (query.scopes.some(scope => scope.kind !== "conversation")) {
        for (const row of await pageRead(SEARCH_LINKS_SQL, [scopesJson, JSON.stringify(missingNotes)])) {
          const resource: ResourceProjection | null = row.projection_json === null ? null : JSON.parse(String(row.projection_json));
          peers.get(String(row.owner_ref))!.push({ref: String(row.ref), resource, scoped: Number(row.external_member) === 1});
        }
      }
      for (const row of await read({sql: SEARCH_RESOURCES_SQL, params: [JSON.stringify(missingNotes)]})) {
        sourceNotes.set(String(row.ref), Number(row.visible) === 1);
      }
    }
    const sources = [...new Set([...candidates.flatMap(({resource, passage}) => passage ? [passage.source_ref] : resource.kind === "highlight" && resource.source_ref ? [resource.source_ref] : []),
      ...noteRefs.flatMap(ref => (peers.get(ref) ?? []).flatMap(peer => peer.scoped ? [] : peer.resource?.kind === "highlight" && peer.resource.source_ref ? [peer.resource.source_ref] : [peer.ref]))])];
    const newSources = sources.filter(ref => !loadedSources.has(ref));
    if (newSources.length) {
      for (const row of await read({sql: SEARCH_ALIASES_SQL, params: [JSON.stringify(newSources)]})) aliases.set(String(row.owner_ref), String(row.target_ref));
      const newReadings = await pageRead(SEARCH_READINGS_SQL, [scopesJson, JSON.stringify(newSources)]);
      if (newReadings.some(row => Number(row.complete) !== 1 || row.reading_ref !== row.source_ref && (row.body_generation === null || row.source_generation === null)))
        return {...result, rows: [], next_cursor: null, scope_available: false};
      const newRefs: string[] = [];
      for (const row of newReadings) {
        const ref = String(row.reading_ref);
        if (readings.has(ref)) continue;
        newRefs.push(ref);
        readings.set(ref, {kind: "reading", reading_ref: ref, source_ref: String(row.source_ref), source_kind: String(row.source_kind),
          body_generation: row.body_generation === null ? null : Number(row.body_generation), source_generation: row.source_generation === null ? null : Number(row.source_generation),
          linked_allowed: Number(row.linked_allowed) === 1, intervals: []});
      }
      if (newRefs.length) for (const row of await pageRead(SEARCH_INTERVALS_SQL, [JSON.stringify(newRefs)])) readings.get(String(row.reading_ref))!.intervals.push({
        kind: "interval", interval_key: String(row.interval_key), reading_ref: String(row.reading_ref), fragment_id: String(row.fragment_id), fragment_idx: Number(row.fragment_idx),
        start_offset: Number(row.start_offset), end_offset: Number(row.end_offset), purpose: row.purpose === "body" ? "body" : "required_note", start_cut: Number(row.start_cut) === 1, end_cut: Number(row.end_cut) === 1,
      });
      for (const source of newSources) loadedSources.add(source);
    }
    const factRefs = [...new Set([...candidates.map(candidate => candidate.resource.ref), ...noteRefs])];
    for (const row of await read({sql: SEARCH_FACTS_SQL, params: [scopesJson, JSON.stringify(factRefs)]})) directFacts.add(String(row.target_ref));
    for (const {resource, passage} of candidates) {
      let match: QueryRow | null = null;
      if (resource.kind === "note" || resource.kind === "page") {
        if (noteInScope(resource.ref)) match = {resource, link: null, match_text: null};
      } else if (resource.kind === "highlight") {
        for (const text of textsForHighlight(resource, false)) if (await matches(text.lexical, expression)) {match = {resource, link: null, match_text: text.literal}; break;}
      } else if (passage && await passageInScope(passage, resource.ref)) match = {resource, link: null, match_text: passage.capture.value.quote_exact};
      if (match) result.rows.push(match);
      if (result.rows.length === limit) return {...result, next_cursor: resource.ref};
    }
    if (raw.length < 100) return result;
    cursor = candidates.at(-1)!.resource.ref;
  }
}

/** Host transactions load permanent same-key bindings before validating identity. */
export function bindingQueries(change: import("./types.ts").Change): { query: AuthoredQuery; selector: "refs" | "link_ids" | "anchor_ids" }[] {
  return [
    ...change.resources.flatMap(resource => resource.kind === "page" && resource.local_date !== null ? [{ query: { kind: "binding" as const, key: { kind: "daily" as const, local_date: resource.local_date } }, selector: "refs" as const }] : []),
    ...change.links.map(link => ({ query: { kind: "binding" as const, key: { kind: "link" as const, endpoint_a: link.endpoint_a, endpoint_b: link.endpoint_b } }, selector: "link_ids" as const })),
    ...change.passages.map(passage => ({ query: { kind: "binding" as const, key: { kind: "passage" as const, source_ref: passage.source_ref, normalized_exact: passage.normalized_exact, prefix: passage.prefix, suffix: passage.suffix } }, selector: "anchor_ids" as const })),
  ];
}

/** Index exactly the presented canonical label/words, including a latent stored
 * daily title's date label. This changes no authored text or capture. */
export function searchText(resource: import("./types.ts").ResourceProjection): string {
  if (resource.kind === "page") return pageTitle(resource.title ?? "", resource.local_date);
  if (resource.kind === "note") return resource.body_text ?? "";
  if (resource.kind === "highlight") return resource.selection?.quote_exact ?? "";
  return resource.title ?? "";
}
