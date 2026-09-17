import { apiCommand204, apiFetch } from "@/lib/api/client";
import {
  expectBoolean,
  expectExactRecord,
  expectNonemptyString,
  expectNullableString,
  expectOneOf,
  expectRecord,
  isRecord,
} from "@/lib/validation";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  expectAuthenticatedShareHref,
  expectPublicShareHref,
  expectResourceGrantHandle,
  expectUserHandle,
} from "@/lib/sharing/wireValidation";
import {
  AUDIENCE_UNAVAILABLE_REASONS,
  isShareMode,
  type AudienceAvailability,
  type OwnedShare,
  type ReceivedUserShare,
  type ShareMode,
  type ShareSnapshot,
  type ShareUserProjection,
} from "@/lib/sharing/types";

const SHARE_MODE_BY_SCHEME: Readonly<Partial<Record<string, ShareMode>>> = {
  media: "ResourceGrants",
  highlight: "HighlightGrants",
  library: "LibraryMembership",
  podcast: "CopyOnly",
  page: "CopyOnly",
  note_block: "CopyOnly",
  conversation: "CopyOnly",
  oracle_reading: "CopyOnly",
  artifact: "CopyOnly",
  contributor: "CopyOnly",
};

function decodeUser(raw: unknown, name: string): ShareUserProjection {
  const row = expectExactRecord(
    raw,
    ["userHandle", "email", "displayName"],
    name,
  );
  return {
    userHandle: expectUserHandle(row.userHandle, `${name}.userHandle`),
    email: expectNullableString(row.email, `${name}.email`),
    displayName: expectNullableString(row.displayName, `${name}.displayName`),
  };
}

function decodeAvailability(raw: unknown, name: string): AudienceAvailability {
  const value = expectRecord(raw, name);
  if (value.kind === "Available") {
    expectExactRecord(value, ["kind"], name);
    return { kind: "Available" };
  }
  if (value.kind === "Unavailable") {
    const row = expectExactRecord(value, ["kind", "reason"], name);
    return {
      kind: "Unavailable",
      reason: expectOneOf(
        row.reason,
        AUDIENCE_UNAVAILABLE_REASONS,
        `${name}.reason`,
      ),
    };
  }
  throw new TypeError(`${name}.kind is invalid`);
}

function decodeOwnedShare(raw: unknown, index: number): OwnedShare {
  const value = expectRecord(raw, `shares[${index}]`);
  if (value.kind === "User") {
    const row = expectExactRecord(
      value,
      ["kind", "handle", "user"],
      `shares[${index}]`,
    );
    return {
      kind: "User",
      handle: expectResourceGrantHandle(row.handle, `shares[${index}].handle`),
      user: decodeUser(row.user, `shares[${index}].user`),
    };
  }
  if (value.kind === "Link") {
    const row = expectExactRecord(
      value,
      ["kind", "handle", "publicHref"],
      `shares[${index}]`,
    );
    return {
      kind: "Link",
      handle: expectResourceGrantHandle(row.handle, `shares[${index}].handle`),
      publicHref: expectPublicShareHref(
        row.publicHref,
        `shares[${index}].publicHref`,
      ),
    };
  }
  throw new TypeError(`shares[${index}].kind is invalid`);
}

function decodeReceivedShare(raw: unknown, index: number): ReceivedUserShare {
  const row = expectExactRecord(
    raw,
    ["kind", "handle", "sharedBy", "subject"],
    `receivedAccess[${index}]`,
  );
  if (row.kind !== "ReceivedUser") {
    throw new TypeError(`receivedAccess[${index}].kind must be ReceivedUser`);
  }
  return {
    kind: "ReceivedUser",
    handle: expectResourceGrantHandle(
      row.handle,
      `receivedAccess[${index}].handle`,
    ),
    sharedBy: decodeUser(row.sharedBy, `receivedAccess[${index}].sharedBy`),
    subject: assumeCanonicalResourceRef(
      expectNonemptyString(row.subject, `receivedAccess[${index}].subject`),
    ),
  };
}

export function decodeShareSnapshot(raw: unknown): ShareSnapshot {
  const envelope = expectExactRecord(raw, ["data"], "share response");
  const data = expectExactRecord(
    envelope.data,
    [
      "subject",
      "sharing",
      "authenticatedHref",
      "creationAvailability",
      "shares",
      "receivedAccess",
    ],
    "share response.data",
  );
  if (!isShareMode(data.sharing)) {
    throw new TypeError("share response.data.sharing is invalid");
  }
  const sharing: ShareMode = data.sharing;
  const availability = expectExactRecord(
    data.creationAvailability,
    ["user", "link"],
    "share response.data.creationAvailability",
  );
  if (!Array.isArray(data.shares) || !Array.isArray(data.receivedAccess)) {
    throw new TypeError(
      "share response shares and receivedAccess must be arrays",
    );
  }
  const subject = assumeCanonicalResourceRef(
    expectNonemptyString(data.subject, "share response.data.subject"),
  );
  const subjectScheme = subject.slice(0, subject.indexOf(":"));
  const expectedMode = SHARE_MODE_BY_SCHEME[subjectScheme];
  if (sharing !== expectedMode) {
    throw new TypeError(
      "share response.data.sharing does not match its subject",
    );
  }
  if (
    expectedMode !== "ResourceGrants" &&
    expectedMode !== "HighlightGrants" &&
    (data.shares.length > 0 || data.receivedAccess.length > 0)
  ) {
    throw new TypeError("non-grant sharing modes must not contain grant rows");
  }
  const linkCount = data.shares.filter(
    (share) => isRecord(share) && share.kind === "Link",
  ).length;
  if (linkCount > 1) {
    throw new TypeError(
      "share response contains more than one creator public link",
    );
  }
  return {
    subject,
    sharing,
    authenticatedHref: expectAuthenticatedShareHref(
      data.authenticatedHref,
      "share response.data.authenticatedHref",
    ),
    creationAvailability: {
      user: decodeAvailability(availability.user, "creationAvailability.user"),
      link: decodeAvailability(availability.link, "creationAvailability.link"),
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
  const envelope = expectExactRecord(raw, ["data"], "create share response");
  const data = expectExactRecord(
    envelope.data,
    ["share", "created"],
    "create share response.data",
  );
  return {
    share: decodeOwnedShare(data.share, 0),
    created: expectBoolean(data.created, "create share response.data.created"),
  };
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
