// Contributor role / content-kind / kind vocabularies shared by the Authors directory,
// the author detail pane, and search. Facet values come from the backend; these map them to
// friendly labels and provide the ordered filter lists used as static filter chips.

export const CONTRIBUTOR_ROLE_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ["author", "Authors"],
  ["editor", "Editors"],
  ["translator", "Translators"],
  ["host", "Hosts"],
  ["guest", "Guests"],
  ["narrator", "Narrators"],
  ["creator", "Creators"],
  ["producer", "Producers"],
  ["channel", "Channels"],
];

export const CONTRIBUTOR_CONTENT_KIND_FILTERS: ReadonlyArray<readonly [string, string]> = [
  ["web_article", "Articles"],
  ["pdf", "PDFs"],
  ["epub", "EPUBs"],
  ["video", "Videos"],
  ["podcast_episode", "Episodes"],
  ["podcast", "Podcasts"],
];

const ROLE_LABELS = new Map(CONTRIBUTOR_ROLE_FILTERS);
const CONTENT_KIND_LABELS = new Map(CONTRIBUTOR_CONTENT_KIND_FILTERS);
const KIND_LABELS = new Map<string, string>([
  ["person", "People"],
  ["organization", "Organizations"],
  ["group", "Groups"],
  ["unknown", "Unknown"],
]);
const STATUS_LABELS = new Map<string, string>([
  ["verified", "Verified"],
  ["unverified", "Unverified"],
]);

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function contributorRoleLabel(value: string): string {
  return ROLE_LABELS.get(value) ?? titleCase(value);
}

export function contributorContentKindLabel(value: string): string {
  return CONTENT_KIND_LABELS.get(value) ?? titleCase(value);
}

export function contributorKindLabel(value: string): string {
  return KIND_LABELS.get(value) ?? titleCase(value);
}

export function contributorStatusLabel(value: string): string {
  return STATUS_LABELS.get(value) ?? titleCase(value);
}
