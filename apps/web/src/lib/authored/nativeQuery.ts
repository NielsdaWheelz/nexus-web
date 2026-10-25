/** The bridge selects one packaged read statement by content identity. It never
 * receives renderer SQL. Parameters and the closed query remain ordinary data. */
import { compileQuery } from "@nexus/authored/queries";
import type { AuthoredQuery } from "@nexus/authored/types";
export async function nativeQueryPlan(query: AuthoredQuery): Promise<{ plan_key: string; params: (string | number | null)[] }> {
  const compiled = compileQuery(query);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(compiled.sql));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { plan_key: `${query.kind}:${hash}`, params: compiled.params };
}
