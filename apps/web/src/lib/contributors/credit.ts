import type { ContributorCredit } from "@/lib/contributors/types";
import {
  expectExactRecord,
  expectInteger,
  expectNullableString,
  expectString,
} from "@/lib/validation";

/** Strict decoder for embedded snake_case contributor credits. */
export function decodeContributorCredit(
  raw: unknown,
  index = 0,
  collectionName = "Contributor credits",
): ContributorCredit {
  const name = `${collectionName}[${index}]`;
  const row = expectExactRecord(
    raw,
    [
      "contributor_handle",
      "contributor_display_name",
      "href",
      "credited_name",
      "role",
      "raw_role",
      "ordinal",
    ],
    name,
  );
  return {
    contributor_handle: expectNullableString(
      row.contributor_handle,
      `${name}.contributor_handle`,
    ),
    contributor_display_name: expectNullableString(
      row.contributor_display_name,
      `${name}.contributor_display_name`,
    ),
    href: expectNullableString(row.href, `${name}.href`),
    credited_name: expectString(row.credited_name, `${name}.credited_name`),
    role: expectString(row.role, `${name}.role`),
    raw_role: expectNullableString(row.raw_role, `${name}.raw_role`),
    ordinal:
      row.ordinal === null
        ? null
        : expectInteger(row.ordinal, `${name}.ordinal`),
  };
}
