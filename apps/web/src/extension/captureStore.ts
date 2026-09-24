// The extension's durable state: the one active capture draft and its
// immutable bytes in IndexedDB "nexus-capture-v1" (keys "draft" and "bytes" of
// one store), and the nexus credential in browser.storage.local. Every write
// resolves only after its transaction commits, so a structured-clone handoff
// acknowledged after `bytes.write` is durable; quota exhaustion is a modeled
// failure. The record shapes are the background's own; the popup never sees
// them and nothing here interprets them.

import type { LibraryDestinationSelection } from "@/lib/libraries/destinationContract";
import { expectExactRecord, expectNonemptyString } from "@/lib/validation";
import {
  CaptureFailureError,
  captureFailure,
  type CaptureAccount,
  type CaptureKind,
  type CapturePhase,
  type CaptureTargetView,
} from "@/extension/captureContract";

export type DocumentSource =
  | {
      kind: "page";
      tabId: number;
      frameId: number;
      /** the native document id of the frame the link was clicked in; a
          replacement document (even a same-url reload) fails to match it */
      documentId: string;
      pageUrl: string;
      /** the link is same-origin with its document, so the page principal
          (`content.fetch`) downloads it with the page's own credentials */
      sameOrigin: boolean;
    }
  | { kind: "extension" };

/** An article is read once, at pinning, so its target keeps only what the
    popup's return and the intent need; a document is read at save, bound to
    the document its link was clicked in. */
export type CaptureTarget =
  | { kind: "article"; windowId: number; url: string }
  | { kind: "document"; windowId: number; url: string; source: DocumentSource };

/** The immutable bytes a capture uploads: the packet, or the downloaded file. */
export interface CaptureBytes {
  kind: CaptureKind;
  blob: Blob;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface CaptureSessionRef {
  handle: string;
  /** the generation nexus last named to this draft: an UploadRequired, or the
      current one a retry conflict reported; never inferred */
  generation: number;
}

export interface CaptureDraftRecord {
  id: string;
  target: CaptureTarget;
  view: CaptureTargetView;
  phase: CapturePhase;
  destinations: readonly LibraryDestinationSelection[];
  /** bound by the first identity lookup; only this account may resume */
  account: CaptureAccount | null;
  /** frozen by save: the operation key is the Idempotency-Key of every create
      replay and the digest is over the stored bytes */
  intent: { operationKey: string; sha256: string } | null;
  /** the upload session once nexus answered UploadRequired */
  session: CaptureSessionRef | null;
}

/** The bearer alone: the nexus it belongs to is the build's pinned origin. */
export interface CaptureCredential {
  token: string;
}

const DATABASE = "nexus-capture-v1";
const STORE = "capture";
const DRAFT_KEY = "draft";
const BYTES_KEY = "bytes";
const CREDENTIAL_KEY = "nexusCaptureCredential";

function storeFailure(error: unknown): CaptureFailureError {
  const name = error instanceof DOMException ? error.name : "unknown";
  return new CaptureFailureError(
    name === "QuotaExceededError"
      ? captureFailure(
          "E_CAPTURE_STORAGE_QUOTA",
          "Firefox has no storage space left for this capture. Free some space and try again.",
        )
      : captureFailure("E_CAPTURE_STORAGE", `Nexus could not store the capture (${name}).`),
  );
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(storeFailure(request.error));
  });
  return database;
}

/** Runs `use` in one transaction and resolves with the last request's result
    only after the transaction committed. */
async function transact<T>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = use(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(storeFailure(transaction.error));
    transaction.onabort = () => reject(storeFailure(transaction.error));
  });
}

export const captureStore = {
  draft: {
    read: (): Promise<CaptureDraftRecord | null> =>
      transact("readonly", (store) => store.get(DRAFT_KEY) as IDBRequest<CaptureDraftRecord | undefined>).then(
        (record) => record ?? null,
      ),
    write: (record: CaptureDraftRecord): Promise<void> =>
      transact("readwrite", (store) => store.put(record, DRAFT_KEY)).then(() => undefined),
    /** a draft owns its bytes: both go */
    clear: (): Promise<void> =>
      transact("readwrite", (store) => {
        store.delete(DRAFT_KEY);
        return store.delete(BYTES_KEY);
      }).then(() => undefined),
  },
  bytes: {
    read: (): Promise<CaptureBytes | null> =>
      transact("readonly", (store) => store.get(BYTES_KEY) as IDBRequest<CaptureBytes | undefined>).then(
        (bytes) => bytes ?? null,
      ),
    write: (bytes: CaptureBytes): Promise<void> =>
      transact("readwrite", (store) => store.put(bytes, BYTES_KEY)).then(() => undefined),
    clear: (): Promise<void> =>
      transact("readwrite", (store) => store.delete(BYTES_KEY)).then(() => undefined),
  },
  credential: {
    /** null when absent; any other shape than exactly {token} is a defect */
    read: async (): Promise<CaptureCredential | null> => {
      const stored = (await browser.storage.local.get(CREDENTIAL_KEY))[CREDENTIAL_KEY];
      if (stored === undefined) return null;
      return { token: expectNonemptyString(expectExactRecord(stored, ["token"], "credential").token, "credential.token") };
    },
    write: (credential: CaptureCredential): Promise<void> =>
      browser.storage.local.set({ [CREDENTIAL_KEY]: credential }),
    clear: (): Promise<void> => browser.storage.local.remove(CREDENTIAL_KEY),
  },
};
