// The single frontend owner of contributor-role recognition, ordering, and
// presentation. Search validation and resource credits derive from this table.
const CONTRIBUTOR_ROLE_DEFINITIONS = [
  { token: "author", singular: "Author", plural: "Authors" },
  { token: "editor", singular: "Editor", plural: "Editors" },
  { token: "translator", singular: "Translator", plural: "Translators" },
  { token: "host", singular: "Host", plural: "Hosts" },
  { token: "guest", singular: "Guest", plural: "Guests" },
  { token: "narrator", singular: "Narrator", plural: "Narrators" },
  { token: "creator", singular: "Creator", plural: "Creators" },
  { token: "producer", singular: "Producer", plural: "Producers" },
  { token: "publisher", singular: "Publisher", plural: "Publishers" },
  { token: "channel", singular: "Channel", plural: "Channels" },
  {
    token: "organization",
    singular: "Organization",
    plural: "Organizations",
  },
  { token: "unknown", singular: "Contributor", plural: "Contributors" },
] as const;

export type ContributorRoleToken =
  (typeof CONTRIBUTOR_ROLE_DEFINITIONS)[number]["token"];

export const CONTRIBUTOR_ROLE_ORDER: readonly ContributorRoleToken[] =
  CONTRIBUTOR_ROLE_DEFINITIONS.map((definition) => definition.token);

export const CONTRIBUTOR_ROLES: ReadonlySet<string> = new Set(
  CONTRIBUTOR_ROLE_ORDER,
);

export function normalizeContributorRoleToken(
  value: string | null | undefined,
): ContributorRoleToken {
  const token = value?.trim();
  return token && CONTRIBUTOR_ROLES.has(token)
    ? (token as ContributorRoleToken)
    : "unknown";
}

export function contributorRoleLabel(
  role: ContributorRoleToken,
  count: number,
): string {
  const definition = CONTRIBUTOR_ROLE_DEFINITIONS.find(
    (candidate) => candidate.token === role,
  );
  if (!definition) {
    throw new Error(`Missing contributor role definition: ${role}`);
  }
  return count === 1 ? definition.singular : definition.plural;
}
