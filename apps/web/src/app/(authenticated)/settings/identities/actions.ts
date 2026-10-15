"use server";

import { withActionSession } from "@/lib/auth/session";
import {
  listIdentities,
  unlinkIdentity,
  type LinkedIdentity,
} from "@/lib/supabase/auth";

// The provider's identity operations as the viewer (withActionSession refreshes
// and publishes the session). The browser holds no provider client.

export async function loadLinkedIdentities(): Promise<
  LinkedIdentity[] | "Failed" | "Ended"
> {
  const result = await withActionSession(listIdentities);
  if (result === "Ended") return "Ended";
  if (result === "Unavailable" || result.outcome !== "Listed") return "Failed";
  return result.identities;
}

/** Idempotent: an identity already gone answers Unlinked (lib/supabase/auth.ts). */
export async function unlinkLinkedIdentity(
  identityId: string,
  provider: string,
): Promise<"Unlinked" | "Failed" | "Ended"> {
  const result = await withActionSession((cookies) =>
    unlinkIdentity(cookies, identityId, provider),
  );
  if (result === "Ended") return "Ended";
  return result !== "Unavailable" && result.outcome === "Unlinked"
    ? "Unlinked"
    : "Failed";
}
