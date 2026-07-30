/** Pure semantic projection for one pane-local Find occurrence. */

import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import type {
  PaneFindResultKey,
  PaneFindResultRow,
} from "@/lib/panes/paneSearch";

function accessibleName({
  row,
  index,
  count,
  active,
}: {
  readonly row: PaneFindResultRow;
  readonly index: number;
  readonly count: number;
  readonly active: boolean;
}): string {
  const location = row.context.join(", ");
  const snippet = row.snippet.map((segment) => segment.text).join("");
  return [
    active ? "Current match" : "Go to match",
    `${index + 1} of ${count}`,
    location,
    snippet,
  ]
    .filter(Boolean)
    .join(": ");
}

export function presentPaneFindResult({
  row,
  index,
  count,
  active,
  onActivate,
}: {
  readonly row: PaneFindResultRow;
  readonly index: number;
  readonly count: number;
  readonly active: boolean;
  readonly onActivate: (key: PaneFindResultKey) => void;
}): CollectionRowView {
  const titleText = row.snippet.map((segment) => segment.text).join("");
  const contextSegments = row.context.flatMap((part, partIndex) => [
    ...(partIndex > 0
      ? [{ text: " / ", emphasized: false } as const]
      : []),
    { text: part, emphasized: false } as const,
  ]);

  return {
    id: row.key,
    kind: "search_result",
    primary: {
      kind: "button",
      label: accessibleName({ row, index, count, active }),
      onActivate: () => onActivate(row.key),
    },
    title: { text: titleText, segments: row.snippet },
    contributors: [],
    publicationDate: absent(),
    context:
      contextSegments.length > 0
        ? present({ kind: "Snippet", segments: contextSegments })
        : absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actionPublication: { kind: "FlatMenu", actions: [] },
    selected: active,
  };
}
