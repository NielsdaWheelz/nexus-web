// Contributor/author frontend types (lightweight-author-deduplication hard cutover).
//
// Two wire cases live here by design (spec D-1):
//  - EMBEDDED read credits inside existing media/search/podcast/library GET DTOs stay
//    snake_case and narrowed to the effective-credit facts (D-33): the
//    `ContributorCredit` below. A handle-less credit is a legitimate text fact
//    (podcast browse/discovery previews, D-9), so `contributor_handle`/`href` are
//    optional.
//  - The five author-surface endpoints speak strict camelCase; their DTOs are the
//    camel types below. Every handle field on those types carries the branded
//    `ContributorHandle` (D-45) — the api-layer decode brands them at ingress.

import type { ContributorHandle } from "@/lib/contributors/handle";

// ---------------------------------------------------------------------------
// Embedded snake credit (narrowed, D-33)
// ---------------------------------------------------------------------------

export interface ContributorCredit {
  contributor_handle?: string | null;
  contributor_display_name?: string | null;
  credited_name: string;
  role: string;
  raw_role?: string | null;
  href?: string | null;
  ordinal?: number | null;
}

// ---------------------------------------------------------------------------
// Author-surface camel DTOs (strict camelCase wire; handles branded, D-45)
// ---------------------------------------------------------------------------

export interface ContributorWorkExample {
  title: string;
  href: string;
}

export interface ContributorSearchItem {
  handle: ContributorHandle;
  href: string;
  displayName: string;
  workCount: number;
  /** At most two example works, used for disambiguation in the picker listbox. */
  workExamples: ContributorWorkExample[];
  /** A non-display alias literal whose normalized form matched, else null. */
  matchedAlias: string | null;
}

export interface ContributorSearchPage {
  contributors: ContributorSearchItem[];
  nextCursor: string | null;
}

export interface ContributorDetail {
  handle: ContributorHandle;
  href: string;
  displayName: string;
  otherNames: string[];
  canRename: boolean;
}

export interface ContributorRoleFact {
  creditedName: string;
  role: string;
  rawRole: string | null;
}

export interface ContributorWorkItem {
  title: string;
  href: string;
  contentKind: string;
  date: string | null;
  roleFacts: ContributorRoleFact[];
}

export interface ContributorWorkPage {
  works: ContributorWorkItem[];
  nextCursor: string | null;
}

export interface MediaAuthorCredit {
  contributorHandle: ContributorHandle;
  href: string;
  displayName: string;
  creditedName: string;
}

export interface MediaAuthors {
  authorMode: "automatic" | "manual";
  authors: MediaAuthorCredit[];
  canEditAuthors: boolean;
}

/** One editor row's binding: an existing visible contributor, or a new person. */
export type AuthorBinding =
  | { kind: "existing"; contributorHandle: ContributorHandle }
  | { kind: "new"; displayName: string };

// ---------------------------------------------------------------------------
// Author-surface request bodies (camelCase; shared by editor + rename)
// ---------------------------------------------------------------------------

export interface MediaAuthorsManualBody {
  clientMutationId: string;
  mode: "manual";
  authors: Array<{ creditedName: string; binding: AuthorBinding }>;
}

export interface MediaAuthorsAutomaticBody {
  clientMutationId: string;
  mode: "automatic";
}

export type MediaAuthorsPutBody = MediaAuthorsManualBody | MediaAuthorsAutomaticBody;

export interface ContributorRenameBody {
  clientMutationId: string;
  displayName: string;
}
