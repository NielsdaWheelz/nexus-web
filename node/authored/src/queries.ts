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
  SELECT ref,projection_json FROM resources WHERE visible=1
  UNION ALL
  SELECT source_ref AS ref,json_object('ref',source_ref,'kind','source','visible',json('true'),'body_pm_json',NULL,'body_text',NULL,'title',json_extract(state_json,'$.capture.value.label'),'local_date',NULL,'source_ref',source_ref,'selection',NULL,'color',NULL,'embedded_refs',json('[]')) AS projection_json
  FROM source_stubs WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.ref=source_stubs.source_ref) AND NOT EXISTS (SELECT 1 FROM passages p WHERE 'passage_anchor:'||p.anchor_id=source_stubs.source_ref)
  UNION ALL
  SELECT 'passage_anchor:'||anchor_id AS ref,json_object('ref','passage_anchor:'||anchor_id,'kind','source','visible',json('true'),'body_pm_json',NULL,'body_text',NULL,'title',json_extract(state_json,'$.capture.value.quote_exact'),'local_date',NULL,'source_ref',source_ref,'selection',NULL,'color',NULL,'embedded_refs',json('[]')) AS projection_json FROM passages
)`;
export function compileQuery(query: AuthoredQuery): CompiledQuery {
  const limit = "limit" in query ? Math.max(1, Math.min(100, Math.floor(query.limit))) : 100;
  switch (query.kind) {
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
    case "daily": return { sql: "SELECT projection_json,NULL AS link_json FROM resources WHERE local_date=? AND visible=1", params: [query.local_date] };
    case "pages": {
      const cursor = readAdjacencyCursor(query.cursor);
      return { sql: `WITH pages AS (SELECT projection_json,ref,COALESCE(NULLIF(title,''),${DAILY_TITLE_SQL},'untitled page') AS display_title FROM resources WHERE kind='page' AND visible=1) SELECT projection_json,NULL AS link_json,json_array(display_title,ref) AS cursor_json FROM pages WHERE (? IS NULL OR display_title>? OR (display_title=? AND ref>?)) ORDER BY display_title,ref LIMIT ?`, params: [cursor?.[0]??null,cursor?.[0]??"",cursor?.[0]??"",cursor?.[1]??"",limit] };
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
          SELECT n.projection_json,l.state_json AS link_json,h.ref AS highlight_ref,l.link_id,
          CASE WHEN l.endpoint_a=h.ref THEN l.position_a ELSE l.position_b END AS position
          FROM resources h JOIN links l ON (l.endpoint_a=h.ref OR l.endpoint_b=h.ref)
          JOIN resources n ON n.ref=CASE WHEN l.endpoint_a=h.ref THEN l.endpoint_b ELSE l.endpoint_a END
          WHERE h.kind='highlight' AND h.source_ref=? AND h.visible=1 AND l.visible=1 AND n.kind='note' AND n.visible=1
        ) SELECT projection_json,link_json,json_array(highlight_ref,position,link_id) AS cursor_json FROM attached WHERE (? IS NULL OR highlight_ref>? OR (highlight_ref=? AND (position>? OR(position=? AND link_id>?)))) ORDER BY highlight_ref,position,link_id LIMIT ?`,
        params:[query.source_ref,cursor?.[0]??null,cursor?.[0]??"",cursor?.[0]??"",cursor?.[1]??"",cursor?.[1]??"",cursor?.[2]??"",limit],
      };
    }
    case "annotations": return { sql: "SELECT projection_json,NULL AS link_json FROM resources WHERE kind='highlight' AND visible=1 AND source_ref=? AND ref>? ORDER BY ref LIMIT ?", params: [query.source_ref, query.cursor ?? "", limit] };
    case "backlinks": return { sql: "SELECT r.projection_json,NULL AS link_json FROM reference_index i JOIN resources r ON r.ref=i.owner_ref WHERE i.target_ref=? AND r.visible=1 AND r.ref>? ORDER BY r.ref LIMIT ?", params: [query.ref, query.cursor ?? "", limit] };
    case "search": return { sql: "SELECT r.projection_json,NULL AS link_json FROM search_fts f JOIN resources r ON r.ref=f.ref WHERE search_fts MATCH ? AND r.visible=1 AND r.ref>? ORDER BY r.ref LIMIT ?", params: [searchExpression(query.text) || '""', query.cursor ?? "", limit] };
    case "adjacency": {
      const cursor = readAdjacencyCursor(query.cursor);
      return {
        sql: `${READABLE}, adjacent AS (
          SELECT r.projection_json,l.state_json AS link_json,l.link_id,
          CASE WHEN l.endpoint_a=? THEN l.position_a ELSE l.position_b END AS position
          FROM links l JOIN readable r ON r.ref=CASE WHEN l.endpoint_a=? THEN l.endpoint_b ELSE l.endpoint_a END
          WHERE (l.endpoint_a=? OR l.endpoint_b=?) AND l.visible=1 AND EXISTS(SELECT 1 FROM readable WHERE ref=?)
        ) SELECT projection_json,link_json,json_array(position,link_id) AS cursor_json FROM adjacent WHERE (? IS NULL OR position>? OR (position=? AND link_id>?)) ORDER BY position,link_id LIMIT ?`,
        params: [query.ref, query.ref, query.ref, query.ref, query.ref, cursor?.[0] ?? null, cursor?.[0] ?? "", cursor?.[0] ?? "", cursor?.[1] ?? "", limit],
      };
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
