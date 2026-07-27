import type {
  SwitchboardItem,
  SwitchboardRowModel,
} from "./model";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function rank(row: SwitchboardRowModel, query: string): number {
  const exact = normalized(row.label) === normalized(query);
  if (row.item === null) return 4;
  switch (row.item.kind) {
    case "OpenPane":
      return exact ? 0 : row.recent ? 2 : 3;
    case "Destination":
      return exact ? 1 : row.recent ? 2 : 3;
    case "ClosedPane":
      return row.recent ? 2 : 3;
    case "Resource":
      if (row.item.match === "Deep") return 4;
      return exact || row.item.match === "Exact"
        ? 1
        : row.recent
          ? 2
          : 3;
  }
}

function ownerProjectedBlocks(
  rows: readonly SwitchboardRowModel[],
  owners: readonly SwitchboardRowModel[],
  query: string,
): SwitchboardRowModel[][] {
  const paneByRoute = new Map<string, SwitchboardRowModel>();
  for (const row of owners) {
    if (
      row.item?.kind === "OpenPane" &&
      !paneByRoute.has(row.item.activationRouteId)
    ) {
      paneByRoute.set(row.item.activationRouteId, row);
    }
  }
  const directResourceByRef = new Map<string, SwitchboardRowModel>();
  for (const row of rows) {
    if (
      row.item?.kind === "Resource" &&
      row.item.occurrenceRef === row.item.ownerRef
    ) {
      directResourceByRef.set(row.item.ownerRef, row);
    }
  }

  const roots = new Map<string, SwitchboardRowModel>();
  const childrenByRoot = new Map<string, SwitchboardRowModel[]>();
  const addRoot = (row: SwitchboardRowModel) => {
    if (!roots.has(row.id)) roots.set(row.id, row);
  };
  const addChild = (root: SwitchboardRowModel, row: SwitchboardRowModel) => {
    addRoot(root);
    const children = childrenByRoot.get(root.id) ?? [];
    if (!children.some((candidate) => candidate.id === row.id)) {
      children.push({ ...row, parentId: root.id });
      childrenByRoot.set(root.id, children);
    }
  };

  for (const row of rows) {
    if (row.item?.kind !== "Resource") {
      addRoot(row);
      continue;
    }
    const owningPane = paneByRoute.get(row.item.activationRouteId);
    if (owningPane) {
      if (row.item.match === "Deep") {
        addChild(owningPane, row);
      } else {
        addRoot(owningPane);
      }
      continue;
    }
    if (row.item.match === "Deep") {
      const directOwner = directResourceByRef.get(row.item.ownerRef);
      if (directOwner) {
        addChild(directOwner, row);
      } else {
        const owner: SwitchboardRowModel = {
          id: `OwnerGroup:${row.item.ownerRef}`,
          item: null,
          label: row.metadata || row.label,
          metadata: "Matching resource",
          recent: row.recent,
        };
        addChild(owner, row);
      }
      continue;
    }
    addRoot(row);
  }

  return [...roots.values()]
    .map((root) => [root, ...(childrenByRoot.get(root.id) ?? [])])
    .sort((left, right) => rank(left[0]!, query) - rank(right[0]!, query));
}

/**
 * Fixed-order merge with active-row stability. New remote rows may refine the
 * tail, but never move the active row or anything already above it.
 */
export function mergeSwitchboardRows(input: {
  query: string;
  previous: readonly SwitchboardRowModel[];
  incoming: readonly SwitchboardRowModel[];
  ownerPanes?: readonly SwitchboardRowModel[];
  activeId: string | null;
}): SwitchboardRowModel[] {
  const unique = new Map<string, SwitchboardRowModel>();
  const blocks = ownerProjectedBlocks(
    input.incoming,
    input.ownerPanes ?? input.incoming,
    input.query,
  );
  for (const row of blocks.flat()) {
    if (!unique.has(row.id)) unique.set(row.id, row);
  }
  const sorted = blocks
    .flat()
    .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index);
  if (input.activeId === null) return sorted;

  const activeIndex = input.previous.findIndex(
    (row) => row.id === input.activeId,
  );
  if (activeIndex < 0) return sorted;
  const prefix = input.previous
    .slice(0, activeIndex + 1)
    .filter((row) => unique.has(row.id));
  const prefixIds = new Set(prefix.map((row) => row.id));
  return [...prefix, ...sorted.filter((row) => !prefixIds.has(row.id))];
}

export function resourceMatchForQuery(
  label: string,
  summary: string,
  query: string,
  source: "Openable" | "Deep",
): Extract<SwitchboardItem, { kind: "Resource" }>["match"] {
  if (source === "Deep") return "Deep";
  return normalized(label) === normalized(query) ? "Exact" : "Metadata";
}
