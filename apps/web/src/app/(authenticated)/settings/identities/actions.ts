"use server";

import {
  normalizeLinkedIdentities,
  type LinkedIdentity,
} from "@/lib/auth/identities";
import { createClient } from "@/lib/supabase/server";

// getUserIdentities and unlinkIdentity are Supabase Auth operations: they run
// server-side against the @supabase/ssr server client, scoped to the signed-in
// user's session cookie. The browser holds no Supabase client.

export type LoadIdentitiesResult =
  | { ok: true; identities: LinkedIdentity[] }
  | { ok: false };

export async function loadLinkedIdentities(): Promise<LoadIdentitiesResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error) {
    return { ok: false };
  }
  return { ok: true, identities: normalizeLinkedIdentities(data) };
}

export type UnlinkIdentityResult = { ok: true } | { ok: false };

export async function unlinkLinkedIdentity(
  identityId: string,
  provider: string
): Promise<UnlinkIdentityResult> {
  const supabase = await createClient();
  // unlinkIdentity wants a full UserIdentity; only identity_id selects the row
  // to delete, and Supabase rejects an identity that is not the caller's own.
  const unlinkPayload = {
    identity_id: identityId,
    provider,
  } as Parameters<typeof supabase.auth.unlinkIdentity>[0];
  const { error } = await supabase.auth.unlinkIdentity(unlinkPayload);
  if (error) {
    return { ok: false };
  }
  return { ok: true };
}
