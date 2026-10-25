"use client";
/** Elective signout freezes new local commands, drains its accepted prefix or
 * obtains explicit discard, then retires before purge. Cancel resumes deferred
 * preparation unchanged. A durable retirement marker owns interrupted cleanup. */
import { FORMAT_REVISION } from "@nexus/authored/types";
import { openAuthoredStore, retireAuthoredAccount } from "./client";
import { markBrowserRetiring, readBrowserRetiring, clearBrowserRetiring } from "./binding";
import { closeWritingRuntime, discardWritingRuntime, hasUncommittedWriting } from "@/lib/notes/runtime";
async function control(accountId: string, op: "pause_commands" | "retire", paused = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = new SharedWorker("/_nexus/authored/worker.js", { type: "module", name: `nexus-authored-${accountId}-format-${FORMAT_REVISION}` });
    const close = () => { clearTimeout(timer); worker.port.postMessage({ id: 3, op: "close" }); worker.port.close(); };
    const timer = setTimeout(() => { close(); reject(new Error("couldn’t close local writing owners. close other nexus tabs and retry sign out.")); }, 30_000);
    worker.port.onmessage = ({ data }) => {
      if (data.kind === "retired" || data.id === 2 && data.ok) { if (op === "retire") retireAuthoredAccount(accountId); close(); resolve(); }
      else if (data.id === 1 && data.ok) worker.port.postMessage({ id: 2, op, paused, account_id: accountId, format_revision: FORMAT_REVISION });
      else if (data.ok === false) { close(); reject(new Error(data.error)); }
    };
    worker.port.start(); worker.port.postMessage(op === "retire" ? { id: 2, op, account_id: accountId, format_revision: FORMAT_REVISION } : { id: 1, op: "hello", account_id: accountId, format_revision: FORMAT_REVISION });
  });
}
async function purgeBrowser(accountId: string): Promise<void> {
  await control(accountId, "retire");
  await discardWritingRuntime(accountId);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`nexus-authored-${accountId}`);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("close other nexus tabs and retry sign out to finish removing local notes."));
  });
  await clearBrowserRetiring();
}
export async function finishBrowserRetirement(): Promise<boolean> {
  const account = await readBrowserRetiring();
  if (account === null) return false;
  await purgeBrowser(account);
  // The shell retirement owner outlives the account menu that requested exit.
  try { await fetch("/auth/signout", { method: "POST", credentials: "same-origin", redirect: "manual" }); }
  catch { /* Offline removal is enforced by the durable signed-out marker. */ }
  return true;
}
export async function prepareAuthoredSignOut(accountId: string): Promise<boolean> {
  const store = await openAuthoredStore(accountId);
  const browser = !("nexusAuthored" in window);
  let retiring = false;
  if (browser) await control(accountId, "pause_commands", true);
  try {
    const replica = await store.readReplica();
    let accepted = replica.command_seq === "0";
    if (!accepted) {
      try { await store.whenUploaded(replica.command_seq, AbortSignal.timeout(3000)); accepted = true; }
      catch { accepted = false; }
    }
    const unfinished = !accepted || hasUncommittedWriting();
    if (browser || unfinished) {
      const message = unfinished
        ? "some changes haven’t been confirmed as synced. signing out removes them from this device and closes your notes in all nexus tabs.\n\ndiscard these changes and sign out?"
        : "sign out on this device? this closes your notes in all nexus tabs. unfinished changes in those tabs will be discarded.";
      if (!window.confirm(message)) return false;
    }
    if (browser) {
      await markBrowserRetiring(accountId); retiring = true;
      await control(accountId, "retire");
    } else if (unfinished) await discardWritingRuntime(accountId);
    else await closeWritingRuntime(accountId);
    return true;
  } finally {
    if (browser && !retiring) await control(accountId, "pause_commands", false);
    await store.close();
  }
}


/** Setup can fail before any store handle exists. Explicit discard still retires
 * all owners and removes its account database; a corrupt store need not open. */
export async function discardFailedAuthoredSetup(accountId: string): Promise<void> {
  if (!window.confirm("sign out on this device? this removes its local notes and any changes that haven’t synced, in every nexus tab.")) return;
  if ("nexusApp" in window) {
    const { sessionSignOut } = await import("@/lib/native/client");
    await discardWritingRuntime(accountId);
    await sessionSignOut(true);
  } else {
    await markBrowserRetiring(accountId);
    await control(accountId, "retire");
  }
}
