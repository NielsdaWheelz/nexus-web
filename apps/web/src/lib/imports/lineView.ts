/**
 * What an intake line says, for every surface that shows one (the import page, share)
 * and for the intake's own slips: the words of docs/import-spec.md's line states,
 * composed from the line alone. Pure but for the build's update remedy, which the
 * transport lines read. It knows no surface: verbs are named, never run.
 */

import type { Line } from "@/components/feedback/stage";
import { TRANSPORT_LINES, type Transport } from "@/lib/api/failure";
import { updateRemedy } from "@/lib/native/admission";
import { CAPTURE_REFUSAL, FAILURE_COPY } from "@/lib/imports/copy";
import type { IntakeLine, LineRefusal, LineStage, Truth } from "@/lib/imports/intake";
import { encodeImportsUrl } from "@/lib/imports/query";
import { libraryNames } from "@/lib/libraries/views";
import { mediaKindLabel } from "@/lib/media/kind";
import type { WorkspaceTarget } from "@/lib/workspace/targetActivation";

/** A press a line or slip offers. `Arm` and `Open` are the row's own: ⏎ or a press on it. */
export type LineVerb =
  | { readonly kind: "Arm" }
  | { readonly kind: "Open"; readonly target: WorkspaceTarget }
  | { readonly kind: "Retry" | "RetryWithout" | "ChooseAgain" | "SignIn" | "Reload"; readonly label: string }
  | { readonly kind: "SeeWhy" | "AllImports"; readonly label: string; readonly target: WorkspaceTarget }
  | { readonly kind: "OpenOriginal"; readonly label: string; readonly href: string };

export interface LineView {
  /** Line one: the pointer until the work is readable, then its title in the reader's face. */
  readonly one: { readonly kind: "Pointer" | "Title"; readonly text: string };
  /** Line two: what is true now. */
  readonly two: string;
  readonly tone: "Neutral" | "Warning" | "Danger";
  readonly verb: LineVerb | null;
  /** Upload progress, 0 to 1, while bytes are going out. */
  readonly rule: number | null;
  /** What × does, where a line has one. */
  readonly dismiss: "Remove" | "Stop" | "Dismiss" | null;
  /** The media a settled line's menu acts on. */
  readonly menu: string | null;
}

const settledTruth = (truth: Truth) => truth.kind === "Readable" || truth.kind === "Failed" || truth.kind === "Removed";

/** Where a line is: sending or waiting to, accepted and not yet settled, or settled. */
export function linePhase(stage: LineStage): "Running" | "Accepted" | "Settled" {
  switch (stage.kind) {
    case "Waiting": case "Sending": case "Uploading": case "Verifying": return "Running";
    case "Accepted": return settledTruth(stage.truth) ? "Settled" : "Accepted";
    case "Refused": case "Unknown": return "Settled";
  }
}

/** A link minus its scheme, a leading `www.` and a trailing `/`. */
export const linkPointer = (url: string) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");

/** A link's pointer; a file's name. */
export function pointer(line: IntakeLine): string {
  return line.source.kind === "File" ? line.source.name : linkPointer(line.source.url);
}

const RETRY = { kind: "Retry", label: "retry" } as const;
const ALL_IMPORTS = { kind: "AllImports", label: "all imports", target: { href: "/imports" } } as const;

/** A transport's line after a command's fact: `couldn’t start. nexus is busy.` */
function transportLine(transport: Transport, fact: string): string {
  const line = TRANSPORT_LINES[transport].command(fact);
  return line.reason === undefined ? line.fact : `${line.fact} ${line.reason}`;
}

/** The transport's verb on a line: retry, sign in, or reload where reload can work. */
function transportVerb(transport: Transport): LineVerb | null {
  switch (TRANSPORT_LINES[transport].verb) {
    case null: return null;
    case "Retry": return RETRY;
    case "SignIn": return { kind: "SignIn", label: "sign in" };
    case "Update": return updateRemedy() === "Reload" ? { kind: "Reload", label: "reload" } : null;
  }
}

type Said = Pick<LineView, "two" | "tone" | "verb">;

function refusalView(line: IntakeLine, refusal: LineRefusal): Said {
  switch (refusal.kind) {
    case "Changed": return { two: CAPTURE_REFUSAL.E_RESOURCE_CONFLICT, tone: "Warning", verb: RETRY };
    case "Active": return {
      two: refusal.unfiled.length === 0 ? CAPTURE_REFUSAL.E_SOURCE_IMPORT_ACTIVE
        : `${CAPTURE_REFUSAL.E_SOURCE_IMPORT_ACTIVE} · not filed to ${libraryNames(refusal.unfiled)}`,
      tone: "Warning", verb: RETRY,
    };
    case "LibraryGone": return refusal.missing.length === 0
      ? { two: `couldn’t file to one of ${libraryNames(line.into)}`, tone: "Warning", verb: RETRY }
      : { two: `can’t file to ${libraryNames(refusal.missing)}`, tone: "Warning",
        verb: { kind: "RetryWithout", label: refusal.missing.length === 1 ? "retry without it" : "retry without them" } };
    case "Ambiguous": return { two: CAPTURE_REFUSAL.E_SOURCE_TARGET_AMBIGUOUS, tone: "Danger", verb: ALL_IMPORTS };
    case "Deleting": return { two: CAPTURE_REFUSAL.E_MEDIA_DELETING, tone: "Neutral", verb: null };
    case "Declared": return { two: CAPTURE_REFUSAL[refusal.code], tone: "Danger", verb: null };
    case "Verification": return { two: `${FAILURE_COPY[refusal.code].reason}.`, tone: "Danger", verb: null };
    case "FileChanged": return { two: "the file changed since the first try.", tone: "Danger", verb: null };
    case "Undeclared": return { two: "couldn’t import this.", tone: "Warning", verb: RETRY };
    case "Handoff": return { two: transportLine(refusal.transport, "couldn’t import this."), tone: "Warning", verb: transportVerb(refusal.transport) };
    case "Offline": return { two: "you’re offline. this hasn’t been sent.", tone: "Warning", verb: RETRY };
    case "NoStart": return { two: transportLine(refusal.transport, "couldn’t start."), tone: "Warning", verb: transportVerb(refusal.transport) };
    // the bytes went, so nothing failed to start: nexus was never asked to check them
    case "CheckHeld": return { two: transportLine(refusal.transport, "couldn’t check the file."), tone: "Warning",
      verb: refusal.transport === "Offline" ? RETRY : transportVerb(refusal.transport) };
    case "WrongType": return { two: "pdf or epub only", tone: "Danger", verb: null };
    case "TooBig": return { two: refusal.fileKind === "Pdf" ? "too big · pdfs up to 100 mb" : "too big · epubs up to 50 mb", tone: "Danger", verb: null };
    case "Empty": return { two: "this file is empty", tone: "Danger", verb: null };
    case "Nameless": return { two: "this file has no name", tone: "Danger", verb: null };
    case "NameTooLong": return { two: "this file’s name is too long", tone: "Danger", verb: null };
    case "BytesLost": return { two: "upload stopped", tone: "Warning", verb: RETRY };
    case "NotPrepared": return { two: "couldn’t start the upload", tone: "Warning", verb: RETRY };
    case "NotChecked": return { two: "couldn’t check the file", tone: "Warning", verb: RETRY };
    case "Expired": return { two: "upload timed out", tone: "Warning",
      verb: line.source.kind === "File" && line.source.file === null ? { kind: "ChooseAgain", label: "choose it again" } : RETRY };
    case "Superseded": return { two: "removed since", tone: "Neutral", verb: null };
    case "Unreadable": return { two: "couldn’t open this file", tone: "Danger", verb: null };
  }
}

function acceptedView(line: IntakeLine, stage: Extract<LineStage, { kind: "Accepted" }>): Pick<LineView, "one"> & Said {
  const one = { kind: "Pointer", text: pointer(line) } as const;
  const open = { kind: "Open", target: { href: stage.href, labelHint: pointer(line) } } as const;
  const truth = stage.truth;
  switch (truth.kind) {
    case "Sent": return { one, two: "sent", tone: "Neutral", verb: open };
    case "Queued": return { one, two: stage.created ? "in line" : "already importing…", tone: "Neutral", verb: open };
    case "Processing": return { one, two: stage.created ? "importing…" : "already importing…", tone: "Neutral", verb: open };
    case "Readable": {
      const { title, contributors, media_kind } = truth.summary;
      const credits = contributors.slice(0, 3).map(credit => credit.credited_name).join(", ")
        + (contributors.length > 3 ? `, +${contributors.length - 3}` : "");
      const facts = credits === "" ? mediaKindLabel(media_kind) : `${credits} · ${mediaKindLabel(media_kind)}`;
      return { one: { kind: "Title", text: title }, two: stage.created ? facts : "already here", tone: "Neutral",
        verb: open };
    }
    case "Failed":
      if (truth.code === "E_SOURCE_ACCESS_DENIED" && line.source.kind === "Link")
        return { one, two: FAILURE_COPY.E_SOURCE_ACCESS_DENIED.reason, tone: "Danger",
          verb: { kind: "OpenOriginal", label: "open original", href: line.source.url } };
      return { one, two: truth.reason === null ? "couldn’t read this" : `couldn’t read this · ${truth.reason}`, tone: "Danger",
        verb: { kind: "SeeWhy", label: "see why",
          target: { href: `/imports?${encodeImportsUrl({ selected: stage.importRef })}`, secondaryActivation: { surfaceId: "import-detail" } } } };
    case "Removed": return { one, two: "removed since", tone: "Neutral", verb: null };
  }
}

export function lineView(line: IntakeLine): LineView {
  const one = { kind: "Pointer", text: pointer(line) } as const;
  const stage = line.stage;
  const armed = line.openOnAccept !== null;
  const running = (two: string, dismiss: LineView["dismiss"]): LineView =>
    ({ one, two: armed ? "opening…" : two, tone: "Neutral", verb: { kind: "Arm" }, rule: null, dismiss, menu: null });
  switch (stage.kind) {
    case "Waiting": return running("waiting…", "Remove");
    case "Sending": return running("sending…", null);
    case "Verifying": return running("checking the file…", null);
    case "Uploading": {
      const fraction = line.source.kind === "File" && line.source.sizeBytes > 0 ? stage.sentBytes / line.source.sizeBytes : 0;
      const percent = Math.floor(fraction * 100);
      return { one, two: armed ? `uploading · ${percent}% · opens when sent` : `uploading · ${percent}%`,
        tone: "Neutral", verb: { kind: "Arm" }, rule: fraction, dismiss: "Stop", menu: null };
    }
    case "Unknown":
      return { one, two: "not sure that imported. it may have gone through.", tone: "Warning", verb: RETRY, rule: null, dismiss: "Dismiss", menu: null };
    case "Refused":
      return { one, ...refusalView(line, stage.refusal), rule: null, dismiss: "Dismiss", menu: null };
    case "Accepted": {
      const settled = settledTruth(stage.truth);
      return { ...acceptedView(line, stage), rule: null, dismiss: settled ? "Dismiss" : null,
        menu: settled && stage.truth.kind !== "Removed" ? stage.mediaId : null };
    }
  }
}

type Outcome = "Imported" | "Unaccounted" | "Unread" | "Refused" | "NotSent" | "AlreadyHere" | "RemovedSince";

/** The colophon's order: the unknown first among the rest, so the cap never hides it. */
const OUTCOMES: readonly (readonly [Outcome, string])[] = [
  ["Imported", "imported"], ["Unaccounted", "unaccounted for"], ["Unread", "couldn’t be read"],
  ["Refused", "refused"], ["NotSent", "not sent"], ["AlreadyHere", "already here"], ["RemovedSince", "removed since"],
];

/** Nexus was never asked to publish: a held confirm's bytes wait in storage, unpublished. */
const NOT_SENT: ReadonlySet<LineRefusal["kind"]> = new Set(["Offline", "NoStart", "CheckHeld", "BytesLost", "NotPrepared", "Unreadable"]);

/** A settled line's part in its batch's ledger. */
function outcome(stage: LineStage): Outcome {
  if (stage.kind === "Unknown") return "Unaccounted";
  if (stage.kind === "Refused")
    return stage.refusal.kind === "Superseded" ? "RemovedSince" : NOT_SENT.has(stage.refusal.kind) ? "NotSent" : "Refused";
  if (stage.kind === "Accepted" && stage.truth.kind === "Readable") return stage.created ? "Imported" : "AlreadyHere";
  if (stage.kind === "Accepted" && stage.truth.kind === "Failed") return "Unread";
  if (stage.kind === "Accepted" && stage.truth.kind === "Removed") return "RemovedSince";
  throw new Error("an unsettled line has no outcome yet");
}

export const spokenCount = (count: number) => count < 10 ? ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][count]! : String(count);

/** A settled batch's ledger line, dated when everything imported. Three named parts at
 * most, the rest summed as `other`, so it keeps to fourteen words. */
function ledger(lines: readonly IntakeLine[], day: string | null): string {
  const parts = OUTCOMES.map(([kind, phrase]) => ({ count: lines.filter(line => outcome(line.stage) === kind).length, phrase }))
    .filter(part => part.count > 0);
  if (parts.length === 1 && parts[0]!.phrase === "imported")
    return day === null ? `${spokenCount(parts[0]!.count)} imported.` : `${spokenCount(parts[0]!.count)} imported, ${day}.`;
  const other = parts.slice(3).reduce((sum, part) => sum + part.count, 0);
  const named = parts.slice(0, 3).map(part => `${spokenCount(part.count)} ${part.phrase}`);
  return `${(other > 0 ? [...named, `${spokenCount(other)} other`] : named).join(", ")}.`;
}

/** The page's close of a settled batch of two or more, dated at its first observed
 * settlement in the reader's zone, day before month. */
export function colophon(lines: readonly IntakeLine[], settledAt: number | null, timeZone: string): string | null {
  if (settledAt === null || lines.length < 2 || lines.some(line => linePhase(line.stage) !== "Settled")) return null;
  const parts = new Intl.DateTimeFormat("en", { timeZone, weekday: "long", day: "numeric", month: "long" }).formatToParts(settledAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)!.value.toLowerCase();
  return ledger(lines, `${part("weekday")} ${part("day")} ${part("month")}`);
}

export type SlipVerb = LineVerb | { readonly kind: "See"; readonly label: string };
export type BatchSlip = { readonly weight: "Plain" | "Held"; readonly line: Line; readonly verb: SlipVerb };

/** The one slip a wholly settled batch raises while no surface shows it: one fact, one verb.
 * Held while anything in it is unaccounted for; none for a lone removal. A verb a slip
 * cannot carry (a picker, a sign-in) becomes `see`, which opens the page. */
export function batchSlip(lines: readonly IntakeLine[]): BatchSlip | null {
  const see = { kind: "See", label: "see" } as const;
  if (lines.length > 1) {
    const unknown = lines.some(line => line.stage.kind === "Unknown");
    return { weight: unknown ? "Held" : "Plain", line: { fact: ledger(lines, null) }, verb: unknown ? RETRY : see };
  }
  const line = lines[0]!;
  const stage = line.stage;
  const name = `“${pointer(line)}”`;
  const view = lineView(line);
  const verb: SlipVerb = view.verb === null || view.verb.kind === "ChooseAgain" || view.verb.kind === "SignIn" ? see : view.verb;
  const outcomeOf = outcome(stage);
  if (outcomeOf === "RemovedSince") return null;
  if (stage.kind === "Unknown") return { weight: "Held", line: { fact: `not sure ${name} imported.`, reason: "it may have gone through." }, verb: RETRY };
  if (outcomeOf === "Imported" || outcomeOf === "AlreadyHere")
    return { weight: "Plain", line: { fact: `“${view.one.text}” is ${outcomeOf === "Imported" ? "ready" : "already here"}.` }, verb };
  // the fence and an exhausted database retry answer alike, and either may follow a join
  // that filed, so it claims neither a removal nor that nothing imported
  if (stage.kind === "Refused" && stage.refusal.kind === "Changed")
    return { weight: "Plain", line: { fact: `something changed while ${name} was sending.` }, verb: RETRY };
  // the line's own sentence, less a fact the slip's own fact already says
  const reason = view.two.replace(/^couldn’t (?:import this\.|start\.|read this(?: · |$))\s*/, "");
  return { weight: "Plain", line: reason === "" ? { fact: `couldn’t import ${name}.` }
    : { fact: `couldn’t import ${name}.`, reason: reason.endsWith(".") ? reason : `${reason}.` }, verb };
}
