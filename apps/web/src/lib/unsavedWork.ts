"use client";

// The one document-exit guard. Leaving asks only when it would lose writing that
// exists only in this tab's memory or stop unfinished browser work such as an
// upload. Recoverable journal rows never ask: they survive the tab. A started
// login navigation never asks: security teardown is not vetoed by an editor.
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { securityTeardownStarted } from "@/lib/auth/UnauthenticatedApiBoundary";
import { readWriting, writingHasMemoryOnlyChanges } from "@/lib/notes/journal";

let browserWork = 0;

/** Unfinished browser work (an upload) holds the exit guard until released. */
export function holdBrowserWork(): () => void {
  browserWork += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    browserWork -= 1;
  };
}

function leavingLosesWork(): boolean {
  return browserWork > 0 || writingHasMemoryOnlyChanges();
}

/**
 * A new build cannot send what this build sealed or could not decode, and may not
 * read this build's journal: such writing needs an explicit download before a
 * reload, as does anything leaving would lose.
 */
export function reloadStrandsWriting(): boolean {
  const { outbox, incompatible } = readWriting();
  return leavingLosesWork() || incompatible.length > 0 || outbox.some(row =>
    row.dispatch.kind === "sealed" && row.dispatch.wire_revision <= WIRE_REVISION);
}

/** Installs the conditional native unload warning; returns its removal. */
export function guardDocumentExit(): () => void {
  const warn = (event: BeforeUnloadEvent) => {
    if (leavingLosesWork() && !securityTeardownStarted()) event.preventDefault();
  };
  window.addEventListener("beforeunload", warn);
  return () => window.removeEventListener("beforeunload", warn);
}
