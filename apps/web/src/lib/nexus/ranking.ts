import {
  nexusEntryKeyValue,
  type NexusEntry,
  type NexusEntryKey,
  type NexusRankTier,
} from "./model";

const TIER_ORDER: Record<NexusRankTier, number> = {
  ExplicitIntent: 0,
  Exact: 1,
  PrefixOrToken: 2,
  CurrentContext: 3,
  FuzzyOrSynonym: 4,
  MetadataOrFullText: 5,
};

const SOURCE_ORDER: Record<NexusEntryKey["kind"], number> = {
  Pane: 0,
  PaneSearch: 1,
  Destination: 2,
  Resource: 3,
  QuickAction: 4,
  ImportUrl: 5,
  Intent: 6,
  ManageTabs: 7,
  Continuation: 8,
};

function normalizedRankValue(
  entry: NexusEntry,
  field: "score" | "frecency",
): number {
  const value = entry.rank[field];
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    // justify-defect: rank inputs are same-system normalized contract values.
    throw new TypeError(
      `Nexus ${field} must be finite and normalized for ${nexusEntryKeyValue(entry.key)}`,
    );
  }
  return value;
}

export function compareNexusEntries(left: NexusEntry, right: NexusEntry): number {
  const leftKey = nexusEntryKeyValue(left.key);
  const rightKey = nexusEntryKeyValue(right.key);
  return (
    TIER_ORDER[left.rank.tier] - TIER_ORDER[right.rank.tier] ||
    normalizedRankValue(right, "score") - normalizedRankValue(left, "score") ||
    normalizedRankValue(right, "frecency") -
      normalizedRankValue(left, "frecency") ||
    SOURCE_ORDER[left.key.kind] - SOURCE_ORDER[right.key.kind] ||
    (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
  );
}

export function rankNexusEntries(entries: readonly NexusEntry[]): NexusEntry[] {
  for (const entry of entries) {
    normalizedRankValue(entry, "score");
    normalizedRankValue(entry, "frecency");
  }
  return [...entries].sort(compareNexusEntries);
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function isOrderedSubsequence(query: string, candidate: string): boolean {
  let cursor = 0;
  for (const character of query) {
    cursor = candidate.indexOf(character, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

function prefixOrToken(query: string, candidate: string): boolean {
  return (
    candidate.startsWith(query) ||
    candidate.split(/\s+/).some((token) => token.startsWith(query))
  );
}

function fuzzy(query: string, candidate: string): boolean {
  return candidate.includes(query) || isOrderedSubsequence(query, candidate);
}

export function nexusTextRankTier(input: {
  readonly query: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly metadata?: readonly string[];
  readonly currentContext?: boolean;
  readonly fullText?: boolean;
  readonly explicitIntent?: boolean;
}): NexusRankTier | null {
  const query = normalized(input.query);
  if (!query) return null;
  if (input.explicitIntent) return "ExplicitIntent";

  const label = normalized(input.label);
  if (label === query) return "Exact";
  if (prefixOrToken(query, label)) return "PrefixOrToken";

  const aliases = (input.aliases ?? []).map(normalized);
  if (aliases.some((alias) => prefixOrToken(query, alias) || fuzzy(query, alias))) {
    return input.currentContext ? "CurrentContext" : "FuzzyOrSynonym";
  }
  if (fuzzy(query, label)) {
    return input.currentContext ? "CurrentContext" : "FuzzyOrSynonym";
  }
  if ((input.metadata ?? []).map(normalized).some((value) => fuzzy(query, value))) {
    return "MetadataOrFullText";
  }
  return input.fullText ? "MetadataOrFullText" : null;
}
