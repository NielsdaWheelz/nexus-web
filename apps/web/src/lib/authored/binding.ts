/** Confirmed browser identity and workspace metadata. This is account authority
 * for local access; expiring credentials only suspend remote work. */
import type { NativeBootstrap } from "@/lib/native/contracts";
import type { WorkspaceState } from "@/lib/workspace/model";
export type BrowserBinding = Pick<NativeBootstrap, "account" | "reader_profile" | "workspace">;
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("nexus-authored-binding", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("binding");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
export async function readBrowserBinding(): Promise<BrowserBinding | null> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction("binding", "readonly").objectStore("binding").get("current");
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
export async function writeBrowserBinding(binding: BrowserBinding): Promise<void> {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("binding", "readwrite", { durability: "strict" });
    const store = tx.objectStore("binding");
    const retiring = store.get("retiring");
    const signedOut = store.get("signed_out");
    const current = store.get("current");
    current.onsuccess = () => {
      const existing = current.result as BrowserBinding | undefined;
      if (retiring.result != null || signedOut.result === true || existing && existing.account.account_id !== binding.account.account_id) { tx.abort(); return; }
      if (!existing) store.put(binding, "current");
    };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
export async function saveBrowserWorkspace(accountId: string, workspace: WorkspaceState) {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("binding", "readwrite", { durability: "strict" });
    const store = tx.objectStore("binding");
    const current = store.get("current");
    const retiring = store.get("retiring");
    retiring.onsuccess = () => {
      const binding = current.result as BrowserBinding | undefined;
      if (retiring.result != null || binding?.account.account_id !== accountId) { tx.abort(); return; }
      store.put({ ...binding, workspace }, "current");
    };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("browser account retired before workspace save")); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}

export async function markBrowserRetiring(accountId: string): Promise<void> {
  const binding = await readBrowserBinding();
  if (binding?.account.account_id !== accountId) throw new Error("browser account changed before sign out");
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("binding", "readwrite", { durability: "strict" });
    tx.objectStore("binding").put(accountId, "retiring");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
export async function readBrowserRetiring(): Promise<string | null> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction("binding", "readonly").objectStore("binding").get("retiring");
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
export async function clearBrowserRetiring(): Promise<void> {
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("binding", "readwrite", { durability: "strict" });
    tx.objectStore("binding").delete("retiring"); tx.objectStore("binding").delete("current"); tx.objectStore("binding").put(true, "signed_out");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}

/** A retired browser account requires a new explicit sign-in intent, even if
 * offline signout could not reach the server to clear its HTTP-only cookies. */
export async function browserSignedOut(): Promise<boolean> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction("binding", "readonly").objectStore("binding").get("signed_out");
    request.onsuccess = () => resolve(request.result === true); request.onerror = () => reject(request.error);
  }); } finally { db.close(); }
}
export async function beginBrowserSignIn(): Promise<void> {
  await navigator.locks.request("nexus-authored-account-transition", async () => {
    // A prior signout must finish its HTTP-only cookie clearing before login.
    const db = await database();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("binding", "readwrite", { durability: "strict" });
      tx.objectStore("binding").delete("signed_out");
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  });
}
