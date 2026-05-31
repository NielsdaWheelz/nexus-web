"use server";

import {
  findSupabaseIdentityForLinkedIdentity,
  mayUnlinkIdentity,
  normalizeLinkedIdentities,
  type LinkedIdentity,
} from "@/lib/auth/identities";
import { createClient } from "@/lib/supabase/server";

// getUserIdentities and unlinkIdentity are Supabase Auth operations: they run
// server-side against the @supabase/ssr server client, scoped to the signed-in
// user's session cookie. The browser holds no Supabase client.

type LoadIdentitiesResult =
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

type UnlinkIdentityResult = { ok: true } | { ok: false };

export async function unlinkLinkedIdentity(
  identityId: string,
  provider: string
): Promise<UnlinkIdentityResult> {
  const supabase = await createClient();
  const { data, error: loadError } = await supabase.auth.getUserIdentities();
  if (loadError) {
    return { ok: false };
  }
  const identities = normalizeLinkedIdentities(data);
  const linkedIdentity =
    identities.find(
      (identity) => identity.id === identityId && identity.provider === provider
    ) ?? null;
  if (!linkedIdentity || !mayUnlinkIdentity(identities, linkedIdentity.id)) {
    return { ok: false };
  }
  const supabaseIdentity = findSupabaseIdentityForLinkedIdentity(
    data,
    linkedIdentity
  );
  if (!supabaseIdentity) {
    return { ok: false };
  }
  const { error } = await supabase.auth.unlinkIdentity(supabaseIdentity);
  if (error) {
    return { ok: false };
  }
  return { ok: true };
}
