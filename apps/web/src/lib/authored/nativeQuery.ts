/** The bridge selects one packaged read statement by content identity. It never
 * receives renderer SQL. Parameters and the closed query remain ordinary data. */
import { compileQuery, type CompiledQuery } from "@nexus/authored/queries";
import type { AuthoredQuery } from "@nexus/authored/types";
export async function nativeQueryPlan(query: AuthoredQuery): Promise<{ plan_key: string; params: (string | number | null)[] }> {
  return statementPlan(compileQuery(query), query.kind);
}
export async function nativeSearchPlan(compiled: CompiledQuery): Promise<{ plan_key: string; params: (string | number | null)[] }> {
  return statementPlan(compiled, "search_read");
}
async function statementPlan(compiled: CompiledQuery, kind: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(compiled.sql));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { plan_key: `${kind}:${hash}`, params: compiled.params };
}
