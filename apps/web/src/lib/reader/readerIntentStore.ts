import { requestResult, transactionCompletion } from "@/lib/browser/indexedDb";
import { readerCursorSourcesEqual, type ReaderCursorSnapshot, type ReaderCursorSource } from "./readerProgress";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

export type SelectedReaderSource = Exclude<ReaderCursorSource, { kind: "Unresolved" }>;

interface ReaderIntent {
  readonly sequence: number;
  readonly source: SelectedReaderSource;
  readonly locator: ReaderResumeState;
}

interface ReaderAttempt extends ReaderIntent {
  readonly baseRevision: number;
}

export interface PendingReaderIntent {
  readonly accountId: string;
  readonly writerId: string;
  readonly mediaId: string;
  readonly desired: ReaderIntent;
  readonly baseline: ReaderCursorSnapshot;
  readonly attempt: ReaderAttempt | null;
}

export interface FrozenReaderIntent {
  readonly row: PendingReaderIntent;
  readonly retained: boolean;
}

function sameAttempt(left: ReaderAttempt | null, right: ReaderAttempt | null): boolean {
  return left === null || right === null ? left === right
    : left.sequence === right.sequence && left.baseRevision === right.baseRevision
      && readerCursorSourcesEqual(left.source, right.source)
      && readerResumeStatesEqual(left.locator, right.locator);
}

/** One row per reader visit. Every operation materializes at most one row. */
export class ReaderIntentStore {
  private opening: Promise<IDBDatabase> | undefined;

  private db(): Promise<IDBDatabase> {
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nexus-reader-pending", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("intents", {
          keyPath: ["accountId", "writerId"],
        });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Reader storage open was blocked"));
    }).catch((error: unknown) => { this.opening = undefined; throw error; });
    return this.opening;
  }

  async capture(input: {
    accountId: string;
    writerId: string;
    mediaId: string;
    sequence: number;
    source: SelectedReaderSource;
    locator: ReaderResumeState;
    baseline: ReaderCursorSnapshot;
  }): Promise<PendingReaderIntent> {
    const db = await this.db();
    const transaction = db.transaction("intents", "readwrite");
    const store = transaction.objectStore("intents");
    const request: IDBRequest<PendingReaderIntent | undefined> = store.get([input.accountId, input.writerId]);
    let row!: PendingReaderIntent;
    request.onsuccess = () => {
      const previous = request.result;
      row = {
        accountId: input.accountId,
        writerId: input.writerId,
        mediaId: input.mediaId,
        desired: {
          sequence: input.sequence,
          source: input.source,
          locator: input.locator,
        },
        baseline: previous?.baseline ?? input.baseline,
        attempt: previous?.attempt ?? null,
      };
      store.put(row);
    };
    await transactionCompletion(transaction);
    return row;
  }

  async get(accountId: string, writerId: string): Promise<PendingReaderIntent | null> {
    const db = await this.db();
    const transaction = db.transaction("intents", "readonly");
    const completed = transactionCompletion(transaction);
    const request: IDBRequest<PendingReaderIntent | undefined> = transaction
      .objectStore("intents").get([accountId, writerId]);
    const row = await requestResult(request);
    await completed;
    return row ?? null;
  }

  async next(accountId: string, afterWriterId?: string): Promise<PendingReaderIntent | null> {
    const db = await this.db();
    const transaction = db.transaction("intents", "readonly");
    const completed = transactionCompletion(transaction);
    const range = afterWriterId === undefined
      ? IDBKeyRange.bound([accountId], [accountId, []])
      : IDBKeyRange.bound([accountId, afterWriterId], [accountId, []], true);
    const cursor = await requestResult(transaction.objectStore("intents").openCursor(range));
    await completed;
    const row: PendingReaderIntent | undefined = cursor?.value;
    return row ?? null;
  }

  /**
   * Concurrent recovery contexts must dispatch the same persisted attempt.
   * `retained` reports that the attempt predates this call, so some context may
   * already have dispatched it; a fresh attempt has never been sent.
   */
  async freeze(accountId: string, writerId: string): Promise<FrozenReaderIntent | null> {
    const db = await this.db();
    const transaction = db.transaction("intents", "readwrite");
    const store = transaction.objectStore("intents");
    const request: IDBRequest<PendingReaderIntent | undefined> = store.get([accountId, writerId]);
    let frozen: FrozenReaderIntent | null = null;
    request.onsuccess = () => {
      const current = request.result;
      if (current === undefined) return;
      if (current.attempt !== null) {
        frozen = { row: current, retained: true };
        return;
      }
      const row: PendingReaderIntent = {
        ...current,
        attempt: { ...current.desired, baseRevision: current.baseline.revision },
      };
      frozen = { row, retained: false };
      store.put(row);
    };
    await transactionCompletion(transaction);
    return frozen;
  }

  /** An acknowledgment cannot remove newer movement or a replacement attempt. */
  async acknowledge(row: PendingReaderIntent, snapshot: ReaderCursorSnapshot): Promise<void> {
    const attempt = row.attempt;
    if (attempt === null) throw new Error("Cannot acknowledge an unfrozen reader intent");
    const db = await this.db();
    const transaction = db.transaction("intents", "readwrite");
    const store = transaction.objectStore("intents");
    const key = [row.accountId, row.writerId];
    const request: IDBRequest<PendingReaderIntent | undefined> = store.get(key);
    request.onsuccess = () => {
      const current = request.result;
      if (current === undefined || !sameAttempt(current.attempt, attempt)) return;
      if (current.desired.sequence === attempt.sequence) store.delete(key);
      else store.put({ ...current, baseline: snapshot, attempt: null });
    };
    await transactionCompletion(transaction);
  }

  /** A visible choice applies only to the exact intent shown by that choice. */
  async resolve(row: PendingReaderIntent, snapshot: ReaderCursorSnapshot, choice: "Canonical" | "Device"): Promise<boolean> {
    const db = await this.db();
    const transaction = db.transaction("intents", "readwrite");
    const store = transaction.objectStore("intents");
    const key = [row.accountId, row.writerId];
    const request: IDBRequest<PendingReaderIntent | undefined> = store.get(key);
    let applied = false;
    request.onsuccess = () => {
      const current = request.result;
      if (current?.desired.sequence !== row.desired.sequence || !sameAttempt(current.attempt, row.attempt)) return;
      if (choice === "Canonical") store.delete(key);
      else store.put({ ...current, baseline: snapshot, attempt: null });
      applied = true;
    };
    await transactionCompletion(transaction);
    return applied;
  }
}
