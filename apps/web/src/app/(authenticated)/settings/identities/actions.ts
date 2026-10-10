"use server";

import { withActionSession } from "@/lib/auth/session";
import {
  listIdentities,
  unlinkIdentity,
  type LinkedIdentity,
} from "@/lib/supabase/auth";

// the provider's identity operations, as the viewer (lib/auth/session.ts
// withActionSession refreshes and publishes). the browser holds no client.

export async function loadLinkedIdentities(): Promise<
  { ok: true; identities: LinkedIdentity[] } | { ok: false }
> {
  const result = await withActionSession(listIdentities);
  return result?.outcome === "Listed"
    ? { ok: true, identities: result.identities }
    : { ok: false };
}

export async function unlinkLinkedIdentity(
  identityId: string,
  provider: string,
): Promise<{ ok: boolean }> {
  const result = await withActionSession((cookies) =>
    unlinkIdentity(cookies, identityId, provider),
  );
  return { ok: result?.outcome === "Unlinked" };
}
