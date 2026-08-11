import type {
  ActivityDeviceClass,
  ActivityCaptureKey,
  ActivityModality,
  ClosedActivitySpan,
  MediaRef,
  ReadingActivitySpanBody,
  ListeningActivitySpanBody,
  ViewingActivitySpanBody,
} from "./activityContract";

export const ACTIVITY_OUTBOX_DB_NAME = "nexus-consumption-activity";
export const ACTIVITY_OUTBOX_MAX_SPANS = 100_000;

const DATABASE_VERSION = 1;
const SPANS_STORE = "spans";
const SETTINGS_STORE = "settings";
const ACCOUNT_STATE_CREATED_AT_INDEX = "accountStateCreatedAt";

export type ActivityFailureReason =
  | "MediaUnavailable"
  | "Expired"
  | "Defect";

interface StoredSpanBase {
  readonly accountId: string;
  readonly captureKey: ActivityCaptureKey;
  readonly mediaRef: MediaRef;
  readonly deviceClass: ActivityDeviceClass;
  readonly createdAt: number;
  readonly state: "Pending" | "Failed";
  readonly failureReason?: ActivityFailureReason;
}

interface StoredReadingSpan extends StoredSpanBase {
  readonly modality: "Reading";
  readonly span: ReadingActivitySpanBody;
}

interface StoredListeningSpan extends StoredSpanBase {
  readonly modality: "Listening";
  readonly span: ListeningActivitySpanBody;
}

interface StoredViewingSpan extends StoredSpanBase {
  readonly modality: "Viewing";
  readonly span: ViewingActivitySpanBody;
}

export type StoredActivitySpan =
  | StoredReadingSpan
  | StoredListeningSpan
  | StoredViewingSpan;

interface ActivitySettings {
  readonly accountId: string;
  readonly paused: boolean;
}

export interface ActivityOutboxSummary {
  readonly total: number;
  readonly pending: number;
  readonly failed: number;
  readonly oldestPendingAt: number | undefined;
  readonly paused: boolean;
}

export interface ActivityOutboxBatch {
  readonly mediaRef: MediaRef;
  readonly modality: ActivityModality;
  readonly deviceClass: ActivityDeviceClass;
  readonly rows: readonly StoredActivitySpan[];
}

export function activityOutboxCapacity(
  count: number,
  limit = ACTIVITY_OUTBOX_MAX_SPANS,
): "Available" | "Reached" {
  return count >= limit ? "Reached" : "Available";
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function accountKeys(accountId: string): IDBKeyRange {
  return IDBKeyRange.bound([accountId, ""], [accountId, "\uffff"]);
}

function accountStateRows(
  accountId: string,
  state: StoredActivitySpan["state"],
): IDBKeyRange {
  return IDBKeyRange.bound(
    [accountId, state, 0],
    [accountId, state, Number.MAX_SAFE_INTEGER],
  );
}

function asStoredSpan(
  accountId: string,
  span: ClosedActivitySpan,
  createdAt: number,
): StoredActivitySpan {
  const base = {
    accountId,
    captureKey: span.captureKey,
    mediaRef: span.mediaRef,
    deviceClass: span.deviceClass,
    createdAt,
    state: "Pending",
  } as const;
  switch (span.modality) {
    case "Reading":
      return { ...base, modality: "Reading", span: span.span };
    case "Listening":
      return { ...base, modality: "Listening", span: span.span };
    case "Viewing":
      return { ...base, modality: "Viewing", span: span.span };
  }
}

export class ActivityOutbox {
  private database: IDBDatabase | undefined;
  private opening: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly maxSpansPerAccount = ACTIVITY_OUTBOX_MAX_SPANS,
  ) {}

  async open(): Promise<void> {
    await this.db();
  }

  async enqueue(
    accountId: string,
    span: ClosedActivitySpan,
    createdAt: number,
  ): Promise<"Enqueued" | "CapacityReached"> {
    const db = await this.db();
    const transaction = db.transaction(SPANS_STORE, "readwrite");
    const store = transaction.objectStore(SPANS_STORE);
    let result: "Enqueued" | "CapacityReached" = "CapacityReached";
    const count = store.count(accountKeys(accountId));
    count.onsuccess = () => {
      if (
        activityOutboxCapacity(count.result, this.maxSpansPerAccount) ===
        "Reached"
      ) {
        return;
      }
      store.add(asStoredSpan(accountId, span, createdAt));
      result = "Enqueued";
    };
    await transactionCompletion(transaction);
    return result;
  }

  async summary(accountId: string): Promise<ActivityOutboxSummary> {
    const db = await this.db();
    const transaction = db.transaction(
      [SPANS_STORE, SETTINGS_STORE],
      "readonly",
    );
    const spans = transaction.objectStore(SPANS_STORE);
    const index = spans.index(ACCOUNT_STATE_CREATED_AT_INDEX);
    const totalRequest = spans.count(accountKeys(accountId));
    const pendingRequest = index.count(accountStateRows(accountId, "Pending"));
    const failedRequest = index.count(accountStateRows(accountId, "Failed"));
    const oldestRequest = index.openCursor(
      accountStateRows(accountId, "Pending"),
    );
    const settingsRequest: IDBRequest<ActivitySettings | undefined> = transaction
      .objectStore(SETTINGS_STORE)
      .get(accountId);
    const completed = transactionCompletion(transaction);
    const [total, pending, failed, oldest, settings] = await Promise.all([
      requestResult(totalRequest),
      requestResult(pendingRequest),
      requestResult(failedRequest),
      requestResult(oldestRequest),
      requestResult(settingsRequest),
    ]);
    await completed;
    const oldestRow: StoredActivitySpan | undefined = oldest?.value;
    return {
      total,
      pending,
      failed,
      oldestPendingAt:
        oldest === null
          ? undefined
          : oldestRow?.createdAt,
      paused: settings?.paused ?? false,
    };
  }

  async nextPendingBatch(
    accountId: string,
    limit: number,
  ): Promise<ActivityOutboxBatch | undefined> {
    const db = await this.db();
    const transaction = db.transaction(SPANS_STORE, "readonly");
    const request = transaction
      .objectStore(SPANS_STORE)
      .index(ACCOUNT_STATE_CREATED_AT_INDEX)
      .openCursor(accountStateRows(accountId, "Pending"));
    const completed = transactionCompletion(transaction);
    const rows = await new Promise<StoredActivitySpan[]>((resolve, reject) => {
      const selected: StoredActivitySpan[] = [];
      let group: Pick<
        StoredActivitySpan,
        "mediaRef" | "modality" | "deviceClass"
      > | undefined;
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || selected.length >= limit) {
          resolve(selected);
          return;
        }
        const row: StoredActivitySpan = cursor.value;
        group ??= row;
        if (
          row.mediaRef === group.mediaRef &&
          row.modality === group.modality &&
          row.deviceClass === group.deviceClass
        ) {
          selected.push(row);
        }
        cursor.continue();
      };
    });
    await completed;
    const first = rows[0];
    return first === undefined
      ? undefined
      : {
          mediaRef: first.mediaRef,
          modality: first.modality,
          deviceClass: first.deviceClass,
          rows,
        };
  }

  async deleteRows(accountId: string, captureKeys: readonly string[]): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction(SPANS_STORE, "readwrite");
    const store = transaction.objectStore(SPANS_STORE);
    for (const captureKey of captureKeys) {
      store.delete([accountId, captureKey]);
    }
    await transactionCompletion(transaction);
  }

  async markFailed(
    accountId: string,
    captureKeys: readonly string[],
    reason: ActivityFailureReason,
  ): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction(SPANS_STORE, "readwrite");
    const store = transaction.objectStore(SPANS_STORE);
    for (const captureKey of captureKeys) {
      const request: IDBRequest<StoredActivitySpan | undefined> = store.get([
        accountId,
        captureKey,
      ]);
      request.onsuccess = () => {
        const row = request.result;
        if (row?.state === "Pending") {
          store.put({ ...row, state: "Failed", failureReason: reason });
        }
      };
    }
    await transactionCompletion(transaction);
  }

  async markExpired(accountId: string, cutoff: number): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction(SPANS_STORE, "readwrite");
    const request = transaction
      .objectStore(SPANS_STORE)
      .index(ACCOUNT_STATE_CREATED_AT_INDEX)
      .openCursor(accountStateRows(accountId, "Pending"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      const row: StoredActivitySpan = cursor.value;
      const endedAt = Date.parse(row.span.occurredAt) + row.span.durationMs;
      if (endedAt < cutoff) {
        cursor.update({
          ...row,
          state: "Failed",
          failureReason: "Expired",
        });
      }
      cursor.continue();
    };
    await transactionCompletion(transaction);
  }

  async setPaused(accountId: string, paused: boolean): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction(SETTINGS_STORE, "readwrite");
    transaction.objectStore(SETTINGS_STORE).put({ accountId, paused });
    await transactionCompletion(transaction);
  }

  async retryFailed(accountId: string): Promise<void> {
    await this.changeFailedRows(accountId, (cursor, row) => {
      cursor.update({
        accountId: row.accountId,
        captureKey: row.captureKey,
        mediaRef: row.mediaRef,
        modality: row.modality,
        deviceClass: row.deviceClass,
        span: row.span,
        createdAt: row.createdAt,
        state: "Pending",
      });
    });
  }

  async discardFailed(accountId: string): Promise<void> {
    await this.changeFailedRows(accountId, (cursor) => cursor.delete());
  }

  private async changeFailedRows(
    accountId: string,
    change: (cursor: IDBCursorWithValue, row: StoredActivitySpan) => void,
  ): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction(SPANS_STORE, "readwrite");
    const request = transaction
      .objectStore(SPANS_STORE)
      .index(ACCOUNT_STATE_CREATED_AT_INDEX)
      .openCursor(accountStateRows(accountId, "Failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      const row: StoredActivitySpan = cursor.value;
      change(cursor, row);
      cursor.continue();
    };
    await transactionCompletion(transaction);
  }

  private async db(): Promise<IDBDatabase> {
    if (this.database !== undefined) return this.database;
    this.opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(
        ACTIVITY_OUTBOX_DB_NAME,
        DATABASE_VERSION,
      );
      request.onupgradeneeded = () => {
        const db = request.result;
        const spans = db.createObjectStore(SPANS_STORE, {
          keyPath: ["accountId", "captureKey"],
        });
        spans.createIndex(
          ACCOUNT_STATE_CREATED_AT_INDEX,
          ["accountId", "state", "createdAt"],
        );
        db.createObjectStore(SETTINGS_STORE, { keyPath: "accountId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new DOMException("Activity storage open was blocked", "InvalidStateError"));
    });
    try {
      this.database = await this.opening;
      this.database.onversionchange = () => {
        this.database?.close();
        this.database = undefined;
        this.opening = undefined;
      };
      return this.database;
    } catch (error) {
      this.opening = undefined;
      throw error;
    }
  }
}
