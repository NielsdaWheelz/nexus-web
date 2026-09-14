import type { NexusHistorySource } from "./model";
import type { NexusRecentTarget } from "./results";
import {
  expectArray,
  expectExactRecord,
  expectFiniteNumber,
  expectIsoInstant,
  expectNonemptyString,
  expectOneOf,
  expectRecord,
} from "@/lib/validation";

// The complete displayed union: openables + owned + panes + destinations + recents.
export const MAX_NEXUS_HISTORY_TARGETS = 95;
export const NEXUS_OWNED_CANDIDATE_LIMIT = 40;

export interface NexusHistoryResponse {
  readonly data: {
    readonly recent: readonly NexusRecentTarget[];
    readonly frecency_by_href: Readonly<Record<string, number>>;
  };
}

export function decodeNexusHistoryResponse(raw: unknown): NexusHistoryResponse {
  const root = expectExactRecord(raw, ["data"], "nexus history response");
  const data = expectExactRecord(
    root.data,
    ["recent", "frecency_by_href"],
    "nexus history data",
  );
  const recent = expectArray(data.recent, (rawItem) => {
    const item = expectExactRecord(
      rawItem,
      ["target_href", "label_snapshot", "source", "last_used_at"],
      "recent target",
    );
    return {
      target_href: expectNonemptyString(item.target_href, "recent target href"),
      label_snapshot: expectNonemptyString(item.label_snapshot, "recent label"),
      source: expectOneOf(
        item.source,
        ["Static", "Workspace", "Recent", "Oracle", "Search", "Ai"],
        "recent source",
      ),
      last_used_at: expectIsoInstant(item.last_used_at, "recent timestamp"),
    };
  }, "recent targets");
  if (recent.length > 5) throw new TypeError("history returned too many recent targets");
  const scores = Object.entries(expectRecord(data.frecency_by_href, "frecency"));
  if (scores.length > MAX_NEXUS_HISTORY_TARGETS) {
    throw new TypeError("history returned too many scores");
  }
  const frecency = Object.fromEntries(scores.map(([href, rawScore]) => {
    expectNonemptyString(href, "frecency target");
    const score = expectFiniteNumber(rawScore, "frecency score");
    if (score < 0 || score > 1) throw new TypeError("frecency score is out of range");
    return [href, score];
  }));
  return { data: { recent, frecency_by_href: frecency } };
}

export interface NexusSelectionRecord {
  readonly query: string | null;
  readonly target_href: string;
  readonly label_snapshot: string;
  readonly source: NexusHistorySource;
}

/** History stores display excerpts; canonical titles and destinations stay intact. */
export function nexusHistoryCommand(
  selection: NexusSelectionRecord,
  clientMutationId: string,
): NexusSelectionRecord & { readonly client_mutation_id: string } {
  return {
    ...selection,
    client_mutation_id: clientMutationId,
    label_snapshot: nexusHistoryLabel(selection.label_snapshot),
    query: nexusHistoryQuery(selection.query),
  };
}

/** The stored display excerpt; empty when the label shows nothing to journal. */
export function nexusHistoryLabel(label: string): string {
  return excerpt(label.replace(/\s+/gu, " ").trim(), 120);
}

export function nexusHistoryQuery(query: string | null): string | null {
  return query === null ? null : excerpt(query.replace(/\s+/gu, " ").trim(), 200);
}

function excerpt(text: string, maxCodePoints: number): string {
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count === maxCodePoints) break;
    end += point.length;
    count += 1;
  }
  return text.slice(0, end);
}
