import type { ClosedActivitySpan } from "./activityContract";

// IndexedDB "nexus-consumption-activity" v1 persists in users' browsers: its stores, keys, index
// and row shape are a contract with every shipped client.

export const ACTIVITY_OUTBOX_MAX_SPANS = 100_000;

export type OutboxRow = ClosedActivitySpan & {
  accountId: string;
  createdAt: number;
  state: "Pending" | "Failed";
};

export interface OutboxSummary {
  total: number;
  pending: number;
  failed: number;
  oldestPendingAt?: number;
  paused: boolean;
}

const BY_STATE = "accountStateCreatedAt";
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("nexus-consumption-activity", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const spans = db.createObjectStore("spans", { keyPath: ["accountId", "captureKey"] });
      spans.createIndex(BY_STATE, ["accountId", "state", "createdAt"]);
      db.createObjectStore("settings", { keyPath: "accountId" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new DOMException("Activity storage open was blocked", "InvalidStateError"));
  });
  database.catch(() => (database = undefined));
  return database;
}

/** One transaction: `body` issues requests and returns a reader of their results. */
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => () => T,
): Promise<T> {
  const transaction = (await open()).transaction(stores, mode);
  const result = body(transaction);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
  return result();
}

const inAccount = (accountId: string) => IDBKeyRange.bound([accountId, ""], [accountId, "￿"]);
const inState = (accountId: string, state: OutboxRow["state"]) =>
  IDBKeyRange.bound([accountId, state, 0], [accountId, state, Number.MAX_SAFE_INTEGER]);

/** Visit the account's rows in `state`, oldest first, until `visit` returns false. */
function eachInState(
  transaction: IDBTransaction,
  accountId: string,
  state: OutboxRow["state"],
  visit: (cursor: IDBCursorWithValue, row: OutboxRow) => boolean | void,
): void {
  const index = transaction.objectStore("spans").index(BY_STATE);
  const request = index.openCursor(inState(accountId, state));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor !== null && visit(cursor, cursor.value) !== false) cursor.continue();
  };
}

const updateEach = (
  accountId: string,
  state: OutboxRow["state"],
  visit: (cursor: IDBCursorWithValue, row: OutboxRow) => void,
) =>
  run(["spans"], "readwrite", (transaction) => {
    eachInState(transaction, accountId, state, visit);
    return () => undefined;
  });

export const outbox = {
  /** Store a closed span as Pending; false when the account already holds the maximum. */
  add: (accountId: string, span: ClosedActivitySpan, now: number) =>
    run(["spans"], "readwrite", (transaction) => {
      const store = transaction.objectStore("spans");
      const count = store.count(inAccount(accountId));
      let added = false;
      count.onsuccess = () => {
        if (count.result >= ACTIVITY_OUTBOX_MAX_SPANS) return;
        store.add({ ...span, accountId, createdAt: now, state: "Pending" } satisfies OutboxRow);
        added = true;
      };
      return () => added;
    }),

  summary: (accountId: string) =>
    run(["spans", "settings"], "readonly", (transaction): (() => OutboxSummary) => {
      const spans = transaction.objectStore("spans");
      const total = spans.count(inAccount(accountId));
      const pending = spans.index(BY_STATE).count(inState(accountId, "Pending"));
      const failed = spans.index(BY_STATE).count(inState(accountId, "Failed"));
      const settings = transaction.objectStore("settings").get(accountId);
      let oldestPendingAt: number | undefined;
      eachInState(transaction, accountId, "Pending", (_, row) => {
        oldestPendingAt = row.createdAt;
        return false;
      });
      return () => ({
        total: total.result,
        pending: pending.result,
        failed: failed.result,
        oldestPendingAt,
        paused: settings.result?.paused ?? false,
      });
    }),

  /** The oldest Pending rows sharing the first one's work, modality and device class. */
  nextBatch: (accountId: string, limit: number) =>
    run(["spans"], "readonly", (transaction) => {
      const rows: OutboxRow[] = [];
      eachInState(transaction, accountId, "Pending", (_, row) => {
        const first = rows[0] ?? row;
        const sameBatch =
          row.mediaRef === first.mediaRef &&
          row.modality === first.modality &&
          row.deviceClass === first.deviceClass;
        if (sameBatch) rows.push(row);
        return rows.length < limit;
      });
      return () => rows;
    }),

  remove: (accountId: string, captureKeys: readonly string[]) =>
    run(["spans"], "readwrite", (transaction) => {
      for (const key of captureKeys) transaction.objectStore("spans").delete([accountId, key]);
      return () => undefined;
    }),

  fail: (accountId: string, captureKeys: readonly string[]) =>
    run(["spans"], "readwrite", (transaction) => {
      const store = transaction.objectStore("spans");
      for (const key of captureKeys) {
        const request = store.get([accountId, key]);
        request.onsuccess = () => {
          const row: OutboxRow | undefined = request.result;
          if (row?.state === "Pending") store.put({ ...row, state: "Failed" });
        };
      }
      return () => undefined;
    }),

  /** Fail Pending rows that ended before the cutoff: the server refuses them anyway. */
  expire: (accountId: string, endedBefore: number) =>
    updateEach(accountId, "Pending", (cursor, row) => {
      if (Date.parse(row.span.occurredAt) + row.span.durationMs < endedBefore) {
        cursor.update({ ...row, state: "Failed" });
      }
    }),

  /** Failed rows become Pending again, dropping the reason earlier clients stored with them. */
  retryFailed: (accountId: string) =>
    updateEach(accountId, "Failed", (cursor, row) => {
      const { failureReason: _, ...retried } = row as OutboxRow & { failureReason?: string };
      cursor.update({ ...retried, state: "Pending" });
    }),

  discardFailed: (accountId: string) =>
    updateEach(accountId, "Failed", (cursor) => cursor.delete()),

  setPaused: (accountId: string, paused: boolean) =>
    run(["settings"], "readwrite", (transaction) => {
      transaction.objectStore("settings").put({ accountId, paused });
      return () => undefined;
    }),
};
