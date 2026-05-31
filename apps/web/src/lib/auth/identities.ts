export type OAuthProvider = "google" | "github";

export interface LinkedIdentity {
  id: string;
  provider: string;
  email: string | null;
  createdAt: string | null;
}

const SUPPORTED_OAUTH_PROVIDERS: OAuthProvider[] = ["google", "github"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    isRecord(identity.identity_data) &&
    "email" in identity.identity_data
  ) {
    const email = identity.identity_data.email;
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
  const identities = isRecord(payload) ? payload.identities : null;
  if (!Array.isArray(identities)) {
    return [];
  }

  return identities.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const id = normalizeIdentityId(entry);
    const provider =
      typeof entry.provider === "string" && entry.provider.trim()
        ? entry.provider
        : null;
    if (!id || !provider) {
      return [];
    }

    const createdAt =
      typeof entry.created_at === "string" && entry.created_at.trim()
        ? entry.created_at
        : null;

    return [
      {
        id,
        provider,
        email: readIdentityEmail(entry),
        createdAt,
      },
    ];
  });
}

export function findSupabaseIdentityForLinkedIdentity<
  T extends SupabaseIdentityRecord,
>(
  payload: { identities?: T[] } | null | undefined,
  identity: Pick<LinkedIdentity, "id" | "provider">
): T | null {
  const identities = payload?.identities;
  if (!Array.isArray(identities)) {
    return null;
  }
  return (
    identities.find(
      (entry) =>
        normalizeIdentityId(entry) === identity.id &&
        entry.provider === identity.provider
    ) ?? null
  );
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

export function findEmailIdentity(
  identities: readonly LinkedIdentity[]
): LinkedIdentity | null {
  return identities.find((identity) => identity.provider === "email") ?? null;
}

export function mayRemovePassword(
  identities: readonly LinkedIdentity[]
): boolean {
  if (identities.length < 2) {
    return false;
  }
  return identities.some((identity) => identity.provider === "email");
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
