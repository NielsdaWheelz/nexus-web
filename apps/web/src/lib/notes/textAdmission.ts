/** Measure the displayed text's actual Yjs updates before either editor or
 * canonical document changes. Keep the live manager as the replay owner. */
import * as Y from "yjs";
import {bodyInline} from "@nexus/authored/documents";
import {CommandTooLargeError, type PageCredit} from "@nexus/authored/types";
import {PageWritingOrigin, transactionUpdate, type WritingDocument} from "./runtime";

export const TEXT_LIMIT = "this edit exceeds the local writing limit.";

type Item = Y.UndoManager["undoStack"][number];

function witness(document: WritingDocument, origin: unknown, credit: PageCredit, mutate: (doc: Y.Doc, history: Y.UndoManager) => void): void {
  const clone = new Y.Doc({gc: false});
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document.doc));
  clone.clientID = document.doc.clientID;
  // Redone identities are local history, so the wire snapshot omits them.
  // Copy the live boundaries before shadowing a retained stack item.
  clone.transact(transaction => {
    for (const structs of document.doc.store.clients.values()) {
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.redone === null) continue;
        const start = Y.getItemCleanStart(transaction, struct.id);
        Y.getItemCleanEnd(transaction, clone.store, struct.lastId);
        start.redone = struct.redone;
      }
    }
  });
  const scope = clone.share.has("body") ? [clone.getXmlFragment("body"), bodyInline(clone)] : clone.getText("title");
  const history = new Y.UndoManager(scope, {trackedOrigins: new Set([origin])});
  let creating = true, changes: Uint8Array[] = [];
  clone.on("update", (update: Uint8Array) => changes.push(update));
  clone.on("afterAllTransactions", () => {
    if (!changes.length) return;
    const update = transactionUpdate(changes); changes = [];
    document.checkTextSize(update.byteLength, credit, creating);
    creating = false;
  });
  try {mutate(clone, history);}
  finally {clone.destroy();}
}

export function admitDisplayedText(document: WritingDocument, baseline: Y.Doc, origin: unknown, mutate: (doc: Y.Doc) => void,
  history: Y.UndoManager | null): void {
  const prior = history && history.lastChange > 0 && Date.now() - history.lastChange < history.captureTimeout ? history.undoStack.at(-1) : undefined;
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(baseline));
    candidate.clientID = baseline.clientID;
    const updates: Uint8Array[] = [];
    candidate.on("update", (update: Uint8Array) => updates.push(update));
    mutate(candidate);
    if (!updates.length) return;
    const update = transactionUpdate(updates);
    const credit = origin instanceof PageWritingOrigin ? origin.credit() : null;
    const exercise = (item?: Item) => witness(document, origin, credit, (clone, history) => {
      if (item) {
        history.undoStack.push({...item});
        history.lastChange = Date.now();
        history.captureTimeout = Infinity;
      }
      Y.applyUpdate(clone, update, origin);
      history.undo();
      history.redo();
    });
    let grouped = prior !== undefined;
    try {exercise(prior);}
    catch (error) {
      if (!grouped || !(error instanceof CommandTooLargeError)) throw error;
      exercise(); grouped = false;
    }
    // Apply the same bytes at both destinations. Yjs interprets an incoming
    // update from its own client id as a collision, so keep the baseline's
    // writer id out of the apply and restore it for the next edit.
    const writer = baseline.clientID;
    baseline.clientID = document.doc.clientID;
    try {Y.applyUpdate(baseline, update);}
    finally {baseline.clientID = writer;}
    // Assign the assessed group even if the sizing read outlasted captureTimeout.
    const timeout = history?.captureTimeout;
    if (history) {
      if (grouped) history.captureTimeout = Infinity;
      else history.stopCapturing();
    }
    try {Y.applyUpdate(document.doc, update, origin);}
    finally {if (history && timeout !== undefined) history.captureTimeout = timeout;}
  } finally {candidate.destroy();}
}

export function checkTextReplay(document: WritingDocument, credit: PageCredit, undo: readonly Item[], future: readonly Item[], redo: boolean): void {
  if (!(redo ? future : undo).length) return;
  witness(document, null, credit, (_doc, history) => {
    history.undoStack.push(...undo.map(item => ({...item})));
    history.redoStack.push(...future.map(item => ({...item})));
    if (redo) history.redo(); else history.undo();
  });
}

export function replayLocalText(document: WritingDocument, history: Y.UndoManager, redo: boolean, refused: () => void): void {
  try {checkTextReplay(document, null, history.undoStack, history.redoStack, redo);}
  catch (error) {
    if (!(error instanceof CommandTooLargeError)) throw error;
    refused(); return;
  }
  if (redo) history.redo(); else history.undo();
}
