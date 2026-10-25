/** Immutable semantic bindings. Existing ids win; fresh ids use disjoint UUIDv5
 * names. Quote normalization serves matching and never rewrites literal capture. */
import { v5 } from "uuid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCHEMES = new Set(["media","library","evidence_span","content_chunk","highlight","page","note_block","fragment","conversation","message","oracle_reading","oracle_passage_anchor","external_snapshot","contributor","podcast","reader_apparatus_item","passage_anchor"]);
export function isResourceRef(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  const [scheme,id,...rest] = ref.split(":");
  return rest.length === 0 && SCHEMES.has(scheme ?? "") && UUID.test(id ?? "");
}
export function sortedEndpoints(a: string,b: string): [string,string] {
  if (!isResourceRef(a) || !isResourceRef(b) || a===b) throw new TypeError("Links require distinct canonical references");
  return a<b?[a,b]:[b,a];
}
export function linkKey(a:string,b:string):string {
  return sortedEndpoints(a,b).map(ref=>`${new TextEncoder().encode(ref).length}:${ref}`).join("");
}
export function dailyId(account_id:string,local_date:string):string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(local_date) || new Date(`${local_date}T00:00:00Z`).toISOString().slice(0,10)!==local_date) throw new TypeError("Invalid local date");
  return v5(`daily:${local_date}`,account_id);
}
export function linkId(account_id:string,a:string,b:string):string { return v5(`link:${linkKey(a,b)}`,account_id); }
export function normalizeQuote(text:string):string { return text.normalize("NFC").replace(/[\p{White_Space}\u001c-\u001f]+/gu," ").replace(/^ +| +$/gu, ""); }
export async function passageKey(exact:string,prefix:string,suffix:string):Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({exact:normalizeQuote(exact),prefix:normalizeQuote(prefix),suffix:normalizeQuote(suffix)}));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
export function passageId(account_id:string,source_ref:string,anchor_key:string):string {
  if (!isResourceRef(source_ref)||!/^[0-9a-f]{64}$/u.test(anchor_key)) throw new TypeError("Invalid passage identity");
  return v5(`passage:${new TextEncoder().encode(source_ref).length}:${source_ref}${anchor_key}`,account_id);
}

/** Permanent bindings preserve seeded ids. A previously unseen key has exactly
 * one derivation. Callers must include existing same-key bindings in the closure. */
export async function validateBindings(account_id: string, states: import("./types.ts").Corpus, changes: readonly import("./types.ts").Change[]): Promise<void> {
  const days = new Map(states.resources.filter(r => r.kind === "page" && r.local_date !== null).map(r => [r.local_date!, r.ref]));
  const links = new Map(states.links.map(l => [linkKey(l.endpoint_a, l.endpoint_b), l.link_id]));
  const passages = new Map(states.passages.map(p => [JSON.stringify([p.source_ref, p.normalized_exact, p.prefix, p.suffix]), p.anchor_id]));
  for (const change of changes) {
    for (const resource of change.resources) if (resource.kind === "page" && resource.local_date !== null) {
      const expected = days.get(resource.local_date) ?? `page:${dailyId(account_id, resource.local_date)}`;
      if (resource.ref !== expected) throw new TypeError("Daily identity disagrees with permanent semantic binding");
      days.set(resource.local_date, resource.ref);
    }
    for (const link of change.links) {
      const key = linkKey(link.endpoint_a, link.endpoint_b);
      const expected = links.get(key) ?? linkId(account_id, link.endpoint_a, link.endpoint_b);
      if (link.link_id !== expected) throw new TypeError("Link identity disagrees with permanent semantic binding");
      links.set(key, link.link_id);
    }
    for (const passage of change.passages) {
      const key = JSON.stringify([passage.source_ref, passage.normalized_exact, passage.prefix, passage.suffix]);
      const expected = passages.get(key) ?? passageId(account_id, passage.source_ref, await passageKey(passage.normalized_exact, passage.prefix, passage.suffix));
      if (passage.anchor_id !== expected) throw new TypeError("Passage identity disagrees with permanent semantic binding");
      passages.set(key, passage.anchor_id);
    }
  }
}
