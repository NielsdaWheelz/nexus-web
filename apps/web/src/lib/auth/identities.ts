export type OAuthProvider = "google" | "github";

export interface LinkedIdentity {
  id: string;
  provider: string;
  email: string | null;
  createdAt: string | null;
}

const SUPPORTED_OAUTH_PROVIDERS: OAuthProvider[] = ["google", "github"];

interface SupabaseIdentityRecord {
  id?: unknown;
  identity_id?: unknown;
  provider?: unknown;
  created_at?: unknown;
  email?: unknown;
  identity_data?: unknown;
}

function readIdentityEmail(identity: SupabaseIdentityRecord): string | null {
  if (typeof identity.email === "string" && identity.email.trim()) {
    return identity.email;
  }

  if (
    identity.identity_data &&
    typeof identity.identity_data === "object" &&
    "email" in identity.identity_data
  ) {
    const email = (identity.identity_data as { email?: unknown }).email;
    if (typeof email === "string" && email.trim()) {
      return email;
    }
  }

  return null;
}

function normalizeIdentityId(identity: SupabaseIdentityRecord): string | null {
  if (typeof identity.identity_id === "string" && identity.identity_id.trim()) {
    return identity.identity_id;
  }
  if (typeof identity.id === "string" && identity.id.trim()) {
    return identity.id;
  }
  return null;
}

export function normalizeLinkedIdentities(payload: unknown): LinkedIdentity[] {
  const identities = (payload as { identities?: unknown } | null)?.identities;
  if (!Array.isArray(identities)) {
    return [];
  }

  return identities.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const identity = entry as SupabaseIdentityRecord;
    const id = normalizeIdentityId(identity);
    const provider =
      typeof identity.provider === "string" && identity.provider.trim()
        ? identity.provider
        : null;
    if (!id || !provider) {
      return [];
    }

    const createdAt =
      typeof identity.created_at === "string" && identity.created_at.trim()
        ? identity.created_at
        : null;

    return [
      {
        id,
        provider,
        email: readIdentityEmail(identity),
        createdAt,
      },
    ];
  });
}

export function getConnectableProviders(
  identities: readonly LinkedIdentity[]
): OAuthProvider[] {
  const linkedProviders = new Set(identities.map((identity) => identity.provider));
  return SUPPORTED_OAUTH_PROVIDERS.filter(
    (provider) => !linkedProviders.has(provider)
  );
}

export function mayUnlinkIdentity(
  identities: readonly LinkedIdentity[],
  identityId: string
): boolean {
  if (identities.length < 2) {
    return false;
  }
  return identities.some((identity) => identity.id === identityId);
}

export function formatIdentityProvider(provider: string): string {
  if (provider === "google") {
    return "Google";
  }
  if (provider === "github") {
    return "GitHub";
  }
  if (provider === "email") {
    return "Email";
  }
  return provider;
}
