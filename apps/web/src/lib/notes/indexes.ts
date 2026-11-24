import type { AuthoredQuery, AuthoredStore, IndexRange, QueryResult } from "@nexus/authored/types";

export type StructuralQuery = Extract<AuthoredQuery, {expected_revision: string | null}>;
export interface AuthoredIndex<Row> {revision: string; items: Row[]; sourceTotal: number}

/** Publish the complete ordered keys of one observation. A revision refusal
 * starts at its head; a range is never assigned a rank in an older result. */
export function subscribeAuthoredIndex<Row>(store: AuthoredStore, query: StructuralQuery,
  select: (result: QueryResult) => IndexRange<Row> | null,
  publish: (value: AuthoredIndex<Row>) => void, failed: (error: unknown) => void): () => void {
  const first = {...query, start: 0, expected_revision: null};
  let live = true, generation = 0, latest: bigint | null = null;
  const receive = (head: QueryResult) => {
    const revision = BigInt(head.store_revision);
    if (!live || latest !== null && revision <= latest) return;
    latest = revision;
    const ticket = ++generation;
    const current = () => live && ticket === generation;
    void (async () => {
      const beginning = select(head);
      if (beginning?.kind !== "range" || beginning.start !== 0) throw new Error("Missing authored index head");
      const items = [...beginning.items];
      while (items.length < beginning.total) {
        const page = await store.query({...query, start: items.length, expected_revision: head.store_revision});
        if (!current()) return;
        const range = select(page);
        if (range?.kind === "changed" || page.store_revision !== head.store_revision) {
          receive(await store.query(first));
          return;
        }
        if (!range || range.start !== items.length || range.total !== beginning.total || !range.items.length) throw new Error("Incomplete authored index range");
        items.push(...range.items);
      }
      if (items.length !== beginning.total) throw new Error("Authored index exceeds its extent");
      if (current()) publish({revision: head.store_revision, items, sourceTotal: beginning.source_total});
    })().catch(error => { if (current()) { latest = null; failed(error); } });
  };
  const stop = store.subscribe(first, receive, error => {
    if (live) { generation++; latest = null; failed(error); }
  });
  return () => { live = false; generation++; stop(); };
}
