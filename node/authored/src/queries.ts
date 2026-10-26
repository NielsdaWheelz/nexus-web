/** Closed bounded local reads. Literal text is escaped into FTS5 phrases. Adjacency
 * pages use the exact (position,link_id) tuple, including prefix/equal keys. */
import type { AuthoredQuery } from "./types.ts";
export interface CompiledQuery { sql: string; params: (string | number | null)[] }
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
  WHEN 'highlight' THEN COALESCE(json_extract(projection_json,'$.selection.quote_exact'),'')
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
    case "search": return { sql: `WITH wanted AS MATERIALIZED(SELECT d.ref FROM search_fts f CROSS JOIN search_documents d ON d.rowid=f.rowid WHERE search_fts MATCH ? AND d.ref>? ORDER BY d.ref LIMIT ?),readable AS NOT MATERIALIZED(${BOUNDED_READABLE}) SELECT projection_json,NULL AS link_json FROM readable ORDER BY ref`, params: [searchExpression(query.text) || '""', query.cursor ?? "", limit] };
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
