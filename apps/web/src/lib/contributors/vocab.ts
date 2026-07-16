// Contributor role vocabulary shared by search. The single FE owner of the role
// token set: the search operator parser validates `role:` tokens against
// CONTRIBUTOR_ROLES. (The directory/facet kind/status/content-kind vocab was
// deleted with the authors directory in the author-dedup cutover.)

export const CONTRIBUTOR_ROLES: ReadonlySet<string> = new Set([
  "author",
  "editor",
  "translator",
  "host",
  "guest",
  "narrator",
  "creator",
  "producer",
  "publisher",
  "channel",
  "organization",
  "unknown",
]);

const ROLE_LABELS = new Map<string, string>([
  ["author", "Authors"],
  ["editor", "Editors"],
  ["translator", "Translators"],
  ["host", "Hosts"],
  ["guest", "Guests"],
  ["narrator", "Narrators"],
  ["creator", "Creators"],
  ["producer", "Producers"],
  ["publisher", "Publishers"],
  ["channel", "Channels"],
  ["organization", "Organizations"],
  ["unknown", "Contributors"],
]);

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function contributorRoleLabel(value: string): string {
  return ROLE_LABELS.get(value) ?? titleCase(value);
}
