// A pane registry is `Map<paneId, record>` whose records carry the routeKey
// they were published for. A record counts only while its pane still shows
// that route; the moment the pane navigates, it is stale and pruned.
interface PaneRouteKeyedRecord {
  readonly routeKey: string;
}

export function routeKeyedRecord<T extends PaneRouteKeyedRecord>(
  records: ReadonlyMap<string, T>,
  paneId: string,
  routeKey: string,
): T | null {
  const record = records.get(paneId);
  return record?.routeKey === routeKey ? record : null;
}

export function pruneRouteKeyedRecords<T extends PaneRouteKeyedRecord>(
  current: ReadonlyMap<string, T>,
  routeKeyByPaneId: ReadonlyMap<string, string>,
): ReadonlyMap<string, T> {
  const kept = [...current].filter(
    ([paneId, record]) => routeKeyByPaneId.get(paneId) === record.routeKey,
  );
  return kept.length === current.size ? current : new Map(kept);
}
