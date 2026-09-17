/**
 * Pane runtime registries are `Map<paneId, record>` where every record carries the
 * routeKey it was published under. A record counts only while the pane is still on
 * that route; the moment the pane navigates, the record is stale and is dropped.
 */
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
  current: Map<string, T>,
  currentRouteKeyByPaneId: ReadonlyMap<string, string>,
): Map<string, T> {
  let next: Map<string, T> | null = null;
  for (const [paneId, record] of current) {
    if (currentRouteKeyByPaneId.get(paneId) === record.routeKey) continue;
    next ??= new Map(current);
    next.delete(paneId);
  }
  return next ?? current;
}
