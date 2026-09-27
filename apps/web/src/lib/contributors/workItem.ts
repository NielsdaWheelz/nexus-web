import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import type {
  ContributorRoleFact,
  ContributorWorkItem,
} from "@/lib/contributors/types";
import { decodeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { decodeMediaSummary } from "@/lib/media/mediaSummary";
import {
  expectArray,
  expectExactRecord,
  expectNullableString,
  expectOneOf,
  expectRecord,
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
  const value = expectRecord(raw, "ContributorWorkItem");
  const kind = expectOneOf(value.kind, ["Media", "Podcast", "ExternalWork"] as const, "ContributorWorkItem.kind");
  if (kind === "Media") {
    const item = expectExactRecord(
      raw,
      ["kind", "mediaSummary", "href", "roleFacts", "actionSubject"],
      "MediaContributorWorkItem",
    );
    return {
      kind,
      mediaSummary: decodeMediaSummary(item.mediaSummary),
      href: expectString(item.href, "MediaContributorWorkItem.href"),
      roleFacts: expectArray(item.roleFacts, decodeRoleFact, "MediaContributorWorkItem.roleFacts"),
      actionSubject: decodeResourceActionSubject(item.actionSubject, "MediaContributorWorkItem.actionSubject"),
    };
  }
  const item = expectExactRecord(
    raw,
    ["kind", "title", "href", "contentKind", "date", "roleFacts", "actionSubject"],
    "ContributorWorkItem",
  );
  const date = expectNullableString(item.date, "ContributorWorkItem.date");
  const common = {
    title: expectString(item.title, "ContributorWorkItem.title"),
    href: expectString(item.href, "ContributorWorkItem.href"),
    contentKind: expectString(item.contentKind, "ContributorWorkItem.contentKind"),
    date: decodeOptionalPublicationDate(date, "ContributorWorkItem.date"),
    roleFacts: expectArray(item.roleFacts, decodeRoleFact, "ContributorWorkItem.roleFacts"),
  };
  if (kind === "ExternalWork") {
    if (item.actionSubject !== null) throw new TypeError("External work cannot have an action subject");
    return { kind, ...common, actionSubject: null };
  }
  return {
    kind,
    ...common,
    actionSubject: decodeResourceActionSubject(item.actionSubject, "ContributorWorkItem.actionSubject"),
  };
}
