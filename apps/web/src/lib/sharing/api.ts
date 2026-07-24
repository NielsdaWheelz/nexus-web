import { apiCommand204, apiFetch } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  expectAuthenticatedShareHref,
  expectPublicShareHref,
  expectResourceGrantHandle,
  expectUserHandle,
} from "@/lib/sharing/wireValidation";
import type {
  AudienceAvailability,
  AudienceUnavailableReason,
  OwnedShare,
  ReceivedUserShare,
  ShareMode,
  ShareSnapshot,
  ShareUserProjection,
} from "@/lib/sharing/types";

const SHARE_MODES = new Set<ShareMode>([
  "None",
  "CopyOnly",
  "CopyWithLibraryFiling",
  "ResourceGrants",
  "HighlightGrants",
  "LibraryMembership",
]);
const UNAVAILABLE_REASONS = new Set<AudienceUnavailableReason>([
  "UnsupportedSubject",
  "Deleting",
  "InsufficientAuthority",
  "HighlightUnresolved",
  "EntitlementRequired",
  "ProjectionNotReady",
  "ProjectionUnsupported",
]);
const SHARE_MODE_BY_SCHEME: Readonly<
  Partial<Record<string, ShareMode>>
> = {
  media: "ResourceGrants",
  highlight: "HighlightGrants",
  library: "LibraryMembership",
  podcast: "CopyWithLibraryFiling",
  page: "CopyOnly",
  note_block: "CopyOnly",
  conversation: "CopyOnly",
  oracle_reading: "CopyOnly",
  artifact: "CopyOnly",
  contributor: "CopyOnly",
};

export class ShareContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed same-system sharing payloads mean the frontend
    // and backend shipped different contracts.
    super(message);
    this.name = "ShareContractDefect";
  }
}

function exactRecord(
  raw: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ShareContractDefect(`${name} must be an object`);
  }
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ShareContractDefect(
      `${name} has keys [${actual.join(", ")}], expected [${expected.join(", ")}]`,
    );
  }
  return raw;
}

function requiredString(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ShareContractDefect(`${name} must be a non-empty string`);
  }
  return raw;
}

function nullableString(raw: unknown, name: string): string | null {
  if (raw === null || typeof raw === "string") return raw;
  throw new ShareContractDefect(`${name} must be a string or null`);
}

function decodeUser(raw: unknown, name: string): ShareUserProjection {
  const row = exactRecord(raw, name, ["userHandle", "email", "displayName"]);
  return {
    userHandle: expectUserHandle(row.userHandle, `${name}.userHandle`),
    email: nullableString(row.email, `${name}.email`),
    displayName: nullableString(row.displayName, `${name}.displayName`),
  };
}

function decodeAvailability(
  raw: unknown,
  name: string,
): AudienceAvailability {
  if (!isRecord(raw)) {
    throw new ShareContractDefect(`${name} must be an object`);
  }
  if (raw.kind === "Available") {
    exactRecord(raw, name, ["kind"]);
    return { kind: "Available" };
  }
  if (raw.kind === "Unavailable") {
    const row = exactRecord(raw, name, ["kind", "reason"]);
    if (
      typeof row.reason !== "string" ||
      !UNAVAILABLE_REASONS.has(row.reason as AudienceUnavailableReason)
    ) {
      throw new ShareContractDefect(`${name}.reason is invalid`);
    }
    return {
      kind: "Unavailable",
      reason: row.reason as AudienceUnavailableReason,
    };
  }
  throw new ShareContractDefect(`${name}.kind is invalid`);
}

function decodeOwnedShare(raw: unknown, index: number): OwnedShare {
  if (!isRecord(raw)) {
    throw new ShareContractDefect(`shares[${index}] must be an object`);
  }
  if (raw.kind === "User") {
    const row = exactRecord(raw, `shares[${index}]`, [
      "kind",
      "handle",
      "user",
    ]);
    return {
      kind: "User",
      handle: expectResourceGrantHandle(
        row.handle,
        `shares[${index}].handle`,
      ),
      user: decodeUser(row.user, `shares[${index}].user`),
    };
  }
  if (raw.kind === "Link") {
    const row = exactRecord(raw, `shares[${index}]`, [
      "kind",
      "handle",
      "publicHref",
    ]);
    return {
      kind: "Link",
      handle: expectResourceGrantHandle(
        row.handle,
        `shares[${index}].handle`,
      ),
      publicHref: expectPublicShareHref(
        row.publicHref,
        `shares[${index}].publicHref`,
      ),
    };
  }
  throw new ShareContractDefect(`shares[${index}].kind is invalid`);
}

function decodeReceivedShare(
  raw: unknown,
  index: number,
): ReceivedUserShare {
  const row = exactRecord(raw, `receivedAccess[${index}]`, [
    "kind",
    "handle",
    "sharedBy",
    "subject",
  ]);
  if (row.kind !== "ReceivedUser") {
    throw new ShareContractDefect(
      `receivedAccess[${index}].kind must be ReceivedUser`,
    );
  }
  return {
    kind: "ReceivedUser",
    handle: expectResourceGrantHandle(
      row.handle,
      `receivedAccess[${index}].handle`,
    ),
    sharedBy: decodeUser(row.sharedBy, `receivedAccess[${index}].sharedBy`),
    subject: assumeCanonicalResourceRef(
      requiredString(row.subject, `receivedAccess[${index}].subject`),
    ),
  };
}

export function decodeShareSnapshot(raw: unknown): ShareSnapshot {
  const envelope = exactRecord(raw, "share response", ["data"]);
  const data = exactRecord(envelope.data, "share response.data", [
    "subject",
    "sharing",
    "authenticatedHref",
    "creationAvailability",
    "shares",
    "receivedAccess",
  ]);
  if (
    typeof data.sharing !== "string" ||
    !SHARE_MODES.has(data.sharing as ShareMode)
  ) {
    throw new ShareContractDefect("share response.data.sharing is invalid");
  }
  const availability = exactRecord(
    data.creationAvailability,
    "share response.data.creationAvailability",
    ["user", "link"],
  );
  if (!Array.isArray(data.shares) || !Array.isArray(data.receivedAccess)) {
    throw new ShareContractDefect(
      "share response shares and receivedAccess must be arrays",
    );
  }
  const subject = assumeCanonicalResourceRef(
    requiredString(data.subject, "share response.data.subject"),
  );
  const subjectScheme = subject.slice(0, subject.indexOf(":"));
  const expectedMode = SHARE_MODE_BY_SCHEME[subjectScheme];
  if (!expectedMode || data.sharing !== expectedMode) {
    throw new ShareContractDefect(
      "share response.data.sharing does not match its subject",
    );
  }
  if (
    expectedMode !== "ResourceGrants" &&
    expectedMode !== "HighlightGrants" &&
    (data.shares.length > 0 || data.receivedAccess.length > 0)
  ) {
    throw new ShareContractDefect(
      "non-grant sharing modes must not contain grant rows",
    );
  }
  const linkCount = data.shares.filter(
    (share) => isRecord(share) && share.kind === "Link",
  ).length;
  if (linkCount > 1) {
    throw new ShareContractDefect(
      "share response contains more than one creator public link",
    );
  }
  return {
    subject,
    sharing: data.sharing as ShareMode,
    authenticatedHref: expectAuthenticatedShareHref(
      data.authenticatedHref,
      subject,
      "share response.data.authenticatedHref",
    ),
    creationAvailability: {
      user: decodeAvailability(
        availability.user,
        "creationAvailability.user",
      ),
      link: decodeAvailability(
        availability.link,
        "creationAvailability.link",
      ),
    },
    shares: data.shares.map(decodeOwnedShare),
    receivedAccess: data.receivedAccess.map(decodeReceivedShare),
  };
}

function sharePath(ref: string): `/api/${string}` {
  return `/api/resource-items/${encodeURIComponent(ref)}/shares`;
}

export async function fetchShareSnapshot(
  ref: string,
  signal?: AbortSignal,
): Promise<ShareSnapshot> {
  return decodeShareSnapshot(
    await apiFetch<unknown>(sharePath(ref), { signal }),
  );
}

function decodeCreateShare(raw: unknown): {
  share: OwnedShare;
  created: boolean;
} {
  const envelope = exactRecord(raw, "create share response", ["data"]);
  const data = exactRecord(envelope.data, "create share response.data", [
    "share",
    "created",
  ]);
  if (typeof data.created !== "boolean") {
    throw new ShareContractDefect(
      "create share response.data.created must be boolean",
    );
  }
  return { share: decodeOwnedShare(data.share, 0), created: data.created };
}

export async function createUserShare(input: {
  ref: string;
  userHandle: string;
}): Promise<{ share: OwnedShare; created: boolean }> {
  const userHandle = expectUserHandle(
    input.userHandle,
    "create user share.userHandle",
  );
  return decodeCreateShare(
    await apiFetch<unknown>(sharePath(input.ref), {
      method: "POST",
      body: JSON.stringify({
        audience: { kind: "User", userHandle },
      }),
    }),
  );
}

export async function createLinkShare(
  ref: string,
): Promise<{ share: OwnedShare; created: boolean }> {
  return decodeCreateShare(
    await apiFetch<unknown>(sharePath(ref), {
      method: "POST",
      body: JSON.stringify({ audience: { kind: "Link" } }),
    }),
  );
}

export async function deleteShare(handle: string): Promise<void> {
  const grantHandle = expectResourceGrantHandle(handle, "delete share.handle");
  await apiCommand204(
    `/api/resource-shares/${encodeURIComponent(grantHandle)}`,
    { method: "DELETE" },
  );
}

export async function searchShareUsers(
  query: string,
  signal?: AbortSignal,
): Promise<ShareUserProjection[]> {
  const raw = await apiFetch<unknown>(
    `/api/users/search?q=${encodeURIComponent(query)}`,
    { signal },
  );
  const envelope = exactRecord(raw, "user search response", ["data"]);
  if (!Array.isArray(envelope.data)) {
    throw new ShareContractDefect("user search response.data must be an array");
  }
  return envelope.data.map((value, index) =>
    decodeUser(value, `user search response.data[${index}]`),
  );
}
