"use client";

import { apiFetch } from "@/lib/api/client";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { expectUserHandle } from "@/lib/sharing/wireValidation";
import {
  expectArray,
  expectExactRecord,
  expectString,
} from "@/lib/validation";

export interface UserSearchResult {
  userHandle: string;
  email: Presence<string>;
  displayName: Presence<string>;
}

function presenceText(raw: unknown, name: string): Presence<string> {
  return decodePresence(raw, (value) => expectString(value, `${name}.value`));
}

export function expectUserSearchResults(raw: unknown): UserSearchResult[] {
  const envelope = expectExactRecord(raw, ["data"], "UserSearchResponse");
  return expectArray(
    envelope.data,
    (value, index) => {
      const name = `UserSearchResponse.data[${index}]`;
      const row = expectExactRecord(
        value,
        ["userHandle", "email", "displayName"],
        name,
      );
      return {
        userHandle: expectUserHandle(row.userHandle, `${name}.userHandle`),
        email: presenceText(row.email, `${name}.email`),
        displayName: presenceText(row.displayName, `${name}.displayName`),
      };
    },
    "UserSearchResponse.data",
  );
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
