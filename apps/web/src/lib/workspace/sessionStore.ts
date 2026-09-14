import { requestResult, transactionCompletion } from "@/lib/browser/indexedDb";
import type { WorkspaceState } from "./schema";

export interface PendingWorkspaceSession {
  readonly accountId: string;
  readonly writerId: string;
  readonly sequence: number;
  readonly state: WorkspaceState;
}

// Browser storage already supplies profile isolation. The server's httpOnly
// device cookie is deliberately not copied into this local recovery identity.
export class WorkspaceSessionStore {
  private opening: Promise<IDBDatabase> | undefined;

  private db(): Promise<IDBDatabase> {
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("nexus-workspace-pending", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("sessions", {
          keyPath: ["accountId", "writerId"],
        }).createIndex("accountId", "accountId");
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Workspace storage open was blocked"));
    }).catch((error: unknown) => { this.opening = undefined; throw error; });
    return this.opening;
  }

  async put(row: PendingWorkspaceSession): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction("sessions", "readwrite");
    transaction.objectStore("sessions").put(row);
    await transactionCompletion(transaction);
  }

  async next(accountId: string): Promise<PendingWorkspaceSession | null> {
    const db = await this.db();
    const transaction = db.transaction("sessions", "readonly");
    const completed = transactionCompletion(transaction);
    const request = transaction.objectStore("sessions").index("accountId").openCursor(accountId);
    const cursor = await requestResult(request);
    await completed;
    const row: PendingWorkspaceSession | undefined = cursor?.value;
    return row ?? null;
  }

  // Retirement of exactly the read row, for either disposition: a server
  // acknowledgment or an explicit discard. A row rewritten since it was read
  // carries newer work and survives.
  async remove(row: PendingWorkspaceSession): Promise<void> {
    const db = await this.db();
    const transaction = db.transaction("sessions", "readwrite");
    const store = transaction.objectStore("sessions");
    const key = [row.accountId, row.writerId];
    const request: IDBRequest<PendingWorkspaceSession | undefined> = store.get(key);
    request.onsuccess = () => {
      if (request.result?.sequence === row.sequence) store.delete(key);
    };
    await transactionCompletion(transaction);
  }

  async get(accountId: string, writerId: string): Promise<PendingWorkspaceSession | undefined> {
    const db = await this.db();
    const transaction = db.transaction("sessions", "readonly");
    const completed = transactionCompletion(transaction);
    const request: IDBRequest<PendingWorkspaceSession | undefined> = transaction
      .objectStore("sessions").get([accountId, writerId]);
    const row = await requestResult(request);
    await completed;
    return row;
  }
}
