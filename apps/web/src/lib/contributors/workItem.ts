import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import type {
  ContributorRoleFact,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import {
  expectArray,
  expectExactRecord,
  expectNullableString,
  expectString,
} from "@/lib/validation";

function decodeRoleFact(raw: unknown, index: number): ContributorRoleFact {
  const name = `ContributorWorkItem.roleFacts[${index}]`;
  const fact = expectExactRecord(
    raw,
    ["creditedName", "role", "rawRole"],
    name,
  );
  return {
    creditedName: expectString(fact.creditedName, `${name}.creditedName`),
    role: expectString(fact.role, `${name}.role`),
    rawRole: expectNullableString(fact.rawRole, `${name}.rawRole`),
  };
}

/** Strict camelCase decoder shared by author pagination and first-paint seeds. */
export function decodeContributorWorkItem(raw: unknown): ContributorWorkItem {
  const item = expectExactRecord(
    raw,
    ["title", "href", "contentKind", "date", "roleFacts"],
    "ContributorWorkItem",
  );
  const date = expectNullableString(item.date, "ContributorWorkItem.date");
  return {
    title: expectString(item.title, "ContributorWorkItem.title"),
    href: expectString(item.href, "ContributorWorkItem.href"),
    contentKind: expectString(item.contentKind, "ContributorWorkItem.contentKind"),
    date: decodeOptionalPublicationDate(date, "ContributorWorkItem.date"),
    roleFacts: expectArray(
      item.roleFacts,
      decodeRoleFact,
      "ContributorWorkItem.roleFacts",
    ),
  };
}
