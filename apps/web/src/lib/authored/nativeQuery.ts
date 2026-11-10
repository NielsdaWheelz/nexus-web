/** One native operation selects packaged statements by content identity. It
 * never receives renderer SQL; the closed query owns the statement count. */
import { compileQuery, compileOutlineWindows, type CompiledQuery } from "@nexus/authored/queries";
import type { AuthoredQuery } from "@nexus/authored/types";
export async function nativeQueryPlans(query: Exclude<AuthoredQuery, {kind: "search_preview" | "search_admission"}>): Promise<{ plan_key: string; params: (string | number | null)[] }[]> {
  const compiled = query.kind === "outline_windows" ? compileOutlineWindows(query) : [compileQuery(query)];
  return Promise.all(compiled.map(plan => statementPlan(plan, query.kind)));
}
export async function nativeSearchPlan(compiled: CompiledQuery): Promise<{ plan_key: string; params: (string | number | null)[] }> {
  return statementPlan(compiled, "search_read");
}
async function statementPlan(compiled: CompiledQuery, kind: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(compiled.sql));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { plan_key: `${kind}:${hash}`, params: compiled.params };
}
