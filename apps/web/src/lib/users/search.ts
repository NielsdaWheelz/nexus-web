"use client";

import { apiFetch } from "@/lib/api/client";
import { expectUserHandle } from "@/lib/sharing/wireValidation";
import {
  expectArray,
  expectExactRecord,
  expectNullableString,
} from "@/lib/validation";

export interface UserSearchResult {
  user_handle: string;
  email: string | null;
  display_name: string | null;
}

export function expectUserSearchResults(raw: unknown): UserSearchResult[] {
  const envelope = expectExactRecord(raw, ["data"], "UserSearchResponse");
  return expectArray(
    envelope.data,
    (value, index) => {
      const name = `UserSearchResponse.data[${index}]`;
      const row = expectExactRecord(
        value,
        ["user_handle", "email", "display_name"],
        name,
      );
      return {
        user_handle: expectUserHandle(row.user_handle, `${name}.user_handle`),
        email: expectNullableString(row.email, `${name}.email`),
        display_name: expectNullableString(row.display_name, `${name}.display_name`),
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
