// The one web owner of credit presentation: the role vocabulary and its
// labels, author selection, role grouping and the handle grammar.

import type { Schema } from "@/lib/api/wire";
import type { PaneHeaderCredit } from "@/lib/panes/paneHeaderModel";

export type ContributorCredit = Schema<"ContributorCreditOut">;
type Role = ContributorCredit["role"];

/** Byline order (authors first) and singular/plural labels. */
const ROLE_LABELS: Readonly<Record<Role, readonly [string, string]>> = {
  author: ["Author", "Authors"],
  editor: ["Editor", "Editors"],
  translator: ["Translator", "Translators"],
  host: ["Host", "Hosts"],
  guest: ["Guest", "Guests"],
  narrator: ["Narrator", "Narrators"],
  creator: ["Creator", "Creators"],
  producer: ["Producer", "Producers"],
  publisher: ["Publisher", "Publishers"],
  channel: ["Channel", "Channels"],
  organization: ["Organization", "Organizations"],
  unknown: ["Contributor", "Contributors"],
};

export const CONTRIBUTOR_ROLES: ReadonlySet<string> = new Set(
  Object.keys(ROLE_LABELS),
);

export function contributorRoleLabel(role: Role, count: number): string {
  return ROLE_LABELS[role][count === 1 ? 0 : 1];
}

interface CreditGroup {
  readonly role: Role;
  readonly label: string;
  readonly credits: readonly PaneHeaderCredit[];
}

/** Author-role credits in credit order; other roles never stand in for authors. */
export function selectMediaAuthors(
  credits: readonly ContributorCredit[],
): readonly ContributorCredit[] {
  return credits.filter((credit) => credit.role === "author");
}

/** The credited name (else the canonical name), linked when the credit has a person. */
export function creditName(credit: ContributorCredit): PaneHeaderCredit | null {
  const label =
    credit.credited_name.trim() || credit.contributor_display_name?.trim();
  if (!label) return null;
  const handle = credit.contributor_handle;
  const href = credit.href ?? (handle ? `/authors/${handle}` : null);
  return href ? { label, href } : { label };
}

/** Credits grouped under role labels, in byline order. */
export function groupContributorCredits(
  credits: readonly ContributorCredit[],
): readonly CreditGroup[] {
  return (Object.keys(ROLE_LABELS) as Role[]).flatMap((role) => {
    const names = credits
      .filter((credit) => credit.role === role)
      .flatMap((credit) => creditName(credit) ?? []);
    if (names.length === 0) return [];
    return [
      { role, label: contributorRoleLabel(role, names.length), credits: names },
    ];
  });
}

/** The handle grammar, for url state that carries a handle (stats). */
export function isContributorHandle(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 80 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}
