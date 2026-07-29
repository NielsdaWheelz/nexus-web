import type {
  NexusEntry,
  NexusEntryKey,
  NexusRankTier,
} from "./model";

const TIER_ORDER: Record<NexusRankTier, number> = {
  Exact: 0,
  Prefix: 1,
  Token: 2,
  Alias: 3,
  OpenContext: 4,
  FuzzyTitle: 5,
  Metadata: 6,
  FullText: 7,
};

const SOURCE_ORDER: Record<NexusEntryKey["kind"], number> = {
  Pane: 0,
  PaneSearch: 1,
  Destination: 2,
  Resource: 3,
  QuickAction: 4,
  ImportUrl: 5,
  Continuation: 6,
};

function normalizedRankValue(
  entry: NexusEntry,
  field: "score" | "frecency",
): number {
  const value = entry.rank[field];
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    // justify-defect: rank inputs are same-system normalized contract values.
    throw new TypeError(
      `Nexus ${field} must be finite and normalized for ${serializeNexusEntryKey(entry.key)}`,
    );
  }
  return value;
}

export function serializeNexusEntryKey(key: NexusEntryKey): string {
  switch (key.kind) {
    case "Pane":
      return `Pane:${key.paneId}`;
    case "PaneSearch":
      return "PaneSearch";
    case "Destination":
      return `Destination:${key.destinationId}`;
    case "Resource":
      return `Resource:${key.occurrenceRef}`;
    case "QuickAction":
      return `QuickAction:${key.actionId}`;
    case "ImportUrl":
      return `ImportUrl:${key.normalizedUrl}`;
    case "Continuation":
      return `Continuation:${key.id}`;
  }
}

export function compareNexusEntries(
  left: NexusEntry,
  right: NexusEntry,
): number {
  const leftKey = serializeNexusEntryKey(left.key);
  const rightKey = serializeNexusEntryKey(right.key);
  return (
    TIER_ORDER[left.rank.tier] - TIER_ORDER[right.rank.tier] ||
    normalizedRankValue(right, "score") -
      normalizedRankValue(left, "score") ||
    normalizedRankValue(right, "frecency") -
      normalizedRankValue(left, "frecency") ||
    SOURCE_ORDER[left.key.kind] - SOURCE_ORDER[right.key.kind] ||
    (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
  );
}

export function rankNexusEntries(
  entries: readonly NexusEntry[],
): NexusEntry[] {
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

export function nexusTextRankTier(input: {
  readonly query: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly openContext?: boolean;
  readonly fallback: "Metadata" | "FullText";
}): NexusRankTier | null {
  const query = normalized(input.query);
  if (!query) return input.openContext ? "OpenContext" : input.fallback;
  const label = normalized(input.label);
  if (label === query) return "Exact";
  if (label.startsWith(query)) return "Prefix";
  if (label.split(/\s+/).some((token) => token.startsWith(query))) {
    return "Token";
  }
  const aliases = (input.aliases ?? []).map(normalized);
  if (
    aliases.some(
      (alias) =>
        alias === query ||
        alias.startsWith(query) ||
        alias.split(/\s+/).some((token) => token.startsWith(query)),
    )
  ) {
    return "Alias";
  }
  if (input.openContext) return "OpenContext";
  if (label.includes(query) || isOrderedSubsequence(query, label)) {
    return "FuzzyTitle";
  }
  if (aliases.some((alias) => alias.includes(query))) return "Metadata";
  return input.fallback === "FullText" ? "FullText" : null;
}
