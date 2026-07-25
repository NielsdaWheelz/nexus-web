"use client";

import { apiFetch } from "@/lib/api/client";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { expectUserHandle } from "@/lib/sharing/wireValidation";
import { isRecord } from "@/lib/validation";

export interface UserSearchResult {
  userHandle: string;
  email: Presence<string>;
  displayName: Presence<string>;
}

export class UserSearchContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed same-system user search payloads mean the
    // frontend and backend shipped different exact contracts.
    super(message);
    this.name = "UserSearchContractDefect";
  }
}

function exactRecord(
  raw: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new UserSearchContractDefect(`${name} must be an object`);
  }
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new UserSearchContractDefect(
      `${name} has keys [${actual.join(", ")}], expected [${expected.join(", ")}]`,
    );
  }
  return raw;
}

function presenceText(raw: unknown, name: string): Presence<string> {
  try {
    return decodePresence(raw, (value) => {
      if (typeof value !== "string") {
        throw new UserSearchContractDefect(
          `${name}.value must be a string`,
        );
      }
      return value;
    });
  } catch (error) {
    if (error instanceof UserSearchContractDefect) throw error;
    throw new UserSearchContractDefect(
      `${name} is invalid: ${
        error instanceof Error ? error.message : "invalid Presence"
      }`,
    );
  }
}

function userHandle(raw: unknown, name: string): string {
  try {
    return expectUserHandle(raw, name);
  } catch (error) {
    throw new UserSearchContractDefect(
      error instanceof Error ? error.message : `${name} is invalid`,
    );
  }
}

export function isUserSearchContractDefect(
  error: unknown,
): error is UserSearchContractDefect {
  return error instanceof UserSearchContractDefect;
}

export function expectUserSearchResults(raw: unknown): UserSearchResult[] {
  const envelope = exactRecord(raw, "UserSearchResponse", ["data"]);
  if (!Array.isArray(envelope.data)) {
    throw new UserSearchContractDefect(
      "UserSearchResponse.data must be an array",
    );
  }
  return envelope.data.map((value, index) => {
    const name = `UserSearchResponse.data[${index}]`;
    const row = exactRecord(value, name, [
      "userHandle",
      "email",
      "displayName",
    ]);
    return {
      userHandle: userHandle(row.userHandle, `${name}.userHandle`),
      email: presenceText(row.email, `${name}.email`),
      displayName: presenceText(row.displayName, `${name}.displayName`),
    };
  });
}

export async function searchUsers(
  query: string,
  signal?: AbortSignal,
): Promise<UserSearchResult[]> {
  return expectUserSearchResults(
    await apiFetch<unknown>(
      `/api/users/search?q=${encodeURIComponent(query.trim())}`,
      { signal },
    ),
  );
}
