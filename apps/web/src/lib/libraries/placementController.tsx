"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import type { LibraryChooserItem, LibraryChooserProps } from "@/components/libraries/LibraryChooser";
import LibraryPlacementOverlay from "@/components/libraries/LibraryPlacementOverlay";
import { changeStamp, publishChange, useChangeStamp } from "@/lib/api/changes";
import { apiTransportFeedback, isApiError, isUnauthenticatedApiError } from "@/lib/api/client";
import type { Presence } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { createLibrary } from "@/lib/libraries/client";
import {
  libraryPlacementDestinationKey, listLibraryPlacements, sendLibraryPlacementCommand,
  type LibraryPlacementDestination, type LibraryPlacementOption, type LibraryPlacementTarget,
  type PlacementCommand, type PlacementReceipt,
} from "@/lib/libraries/libraryPlacement";
import { readPlacementJournal, writePlacementJournal, type StoredLibraryWork } from "@/lib/libraries/placementJournal";
import { libraryCreateRefusalMessage, libraryPlacementRefusalMessage, libraryRequestErrorMessage } from "@/lib/libraries/libraryRequestErrorMessage";
import { isReservedLibraryName } from "@/lib/libraries/presentation";
import { isAbortError } from "@/lib/errors";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";

const DELIVERY_TIMEOUT_MS = 30_000;
const UNKNOWN: FeedbackContent = { tone: "Warning", title: "change not confirmed", message: "retry the same change to confirm its result." };
const STORAGE: FeedbackContent = { tone: "Warning", title: "library changes couldn’t be saved for recovery", message: "retry after browser storage is available." };

type Failure = { content: FeedbackContent; onRetry: (() => void) | null };
type Inventory = {
  target: LibraryPlacementTarget;
  rows: readonly LibraryPlacementOption[] | null;
  loading: boolean;
  readPromise: Promise<void> | null;
  needsRead: boolean;
  stamp: string | null;
  unavailable: boolean;
  failure: Failure | null;
  readers: number;
  visibleReaders: number;
  generation: number;
  writes: number;
  reconciling: readonly PlacementCommand[];
};
type Completion =
  | { kind: "Placement"; receipt: PlacementReceipt }
  | { kind: "Created" }
  | { kind: "CreateRefused"; content: FeedbackContent };
export type LibraryWorkAdmission =
  | { kind: "Accepted"; commandIds: readonly string[]; completion: Promise<boolean> }
  | { kind: "Rejected"; feedback: FeedbackContent };
export interface LibraryPlacementOpenOptions {
  anchor: ReturnFocusTarget;
  returnFocusFallback: Presence<ReturnFocusTarget>;
}
export interface LibraryPlacementSession {
  key: number;
  target: LibraryPlacementTarget;
  options: LibraryPlacementOpenOptions;
}
export type LibraryPlacementView = Pick<LibraryChooserProps, "items" | "loading" | "summary" | "error" | "status" | "onCommit"> & {
  creationAvailable: boolean;
  pendingNames: readonly string[];
  onCreate: (name: string) => "Accepted" | "Rejected";
};

function targetKey(target: LibraryPlacementTarget): string { return `${target.kind}:${target.id}`; }
function commandTarget(command: PlacementCommand): LibraryPlacementTarget {
  return "mediaId" in command
    ? { kind: "Media", id: command.mediaId } : { kind: "Podcast", id: command.podcastId };
}
function commandDestination(command: PlacementCommand): string {
  if ("mediaId" in command) {
    return command.destination.kind === "SavedInNexus" ? "SavedInNexus" : `Library:${command.destination.libraryId}`;
  }
  return `Library:${command.libraryId}`;
}
function isAdd(command: PlacementCommand): boolean { return command.kind === "AddMedia" || command.kind === "AddPodcast"; }
function workId(work: StoredLibraryWork): string { return work.kind === "Placement" ? work.request.clientMutationId : work.request.library_id; }
function placementCommand(target: LibraryPlacementTarget, destination: LibraryPlacementDestination, included: boolean): PlacementCommand {
  const clientMutationId = crypto.randomUUID();
  if (target.kind === "Podcast") {
    if (destination.kind !== "Library") throw new Error("podcast placement requires a named library");
    return { kind: included ? "AddPodcast" : "RemovePodcast", clientMutationId, podcastId: target.id, libraryId: destination.library.id };
  }
  return {
    kind: included ? "AddMedia" : "RemoveMedia", clientMutationId, mediaId: target.id,
    destination: destination.kind === "SavedInNexus" ? destination : { kind: "Library", libraryId: destination.library.id },
  };
}

/** One account's accepted commands. Views subscribe; only this owner sends/retires work. */
function createPlacementOwner(accountId: string) {
  let alive = false;
  let epoch = 0;
  let loaded = false;
  let authenticationLost = false;
  let defect: unknown | null = null;
  let work: readonly StoredLibraryWork[] = [];
  let snapshot = { revision: 0 };
  let storageFailure: FeedbackContent | null = null;
  let invalidJournal = false;
  const inventories = new Map<string, Inventory>();
  const listeners = new Set<() => void>();
  const acknowledgements = new Set<(target: LibraryPlacementTarget) => void>();
  const sending = new Set<string>();
  const uncertain = new Set<string>();
  const failures = new Map<string, { content: FeedbackContent; targets: readonly string[] }>();
  const completed = new Map<string, Completion>();
  const createdForPlacement = new Map<string, string>();
  const observers = new Map<string, (confirmed: boolean) => void>();

  function changed() {
    snapshot = { revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  }
  function inventory(target: LibraryPlacementTarget): Inventory {
    const key = targetKey(target);
    const found = inventories.get(key);
    if (found) return found;
    const row: Inventory = { target, rows: null, loading: false, readPromise: null, needsRead: true, stamp: null, unavailable: false, failure: null, readers: 0, visibleReaders: 0, generation: 0, writes: 0, reconciling: [] };
    inventories.set(key, row);
    return row;
  }
  function relevant(entry: StoredLibraryWork, keys: ReadonlySet<string>): boolean {
    if (entry.kind === "Placement") return keys.has(targetKey(commandTarget(entry.request)));
    return work.some((child) => child.kind === "Placement" && child.afterCreate === entry.request.library_id && keys.has(targetKey(commandTarget(child.request))));
  }
  function prune() {
    for (const [key, row] of inventories) {
      if (row.readers === 0 && row.reconciling.length === 0 && !work.some((entry) => entry.kind === "Placement" && targetKey(commandTarget(entry.request)) === key)) {
        row.generation += 1;
        inventories.delete(key);
      }
    }
  }
  function read(target: LibraryPlacementTarget): Promise<void> {
    const row = inventory(target);
    row.needsRead = true;
    if (row.readPromise !== null) return row.readPromise;
    if (!alive || authenticationLost || sending.has(targetKey(target))) return Promise.resolve();
    row.loading = true;
    const generation = ++row.generation;
    const readEpoch = epoch;
    changed();
    const current = () => alive && epoch === readEpoch && row.generation === generation;
    const run = async () => {
      try {
        do {
          row.needsRead = false;
          const writes = row.writes;
          const stamp = changeStamp("Libraries", "Entries");
          const stale = () => writes !== row.writes || stamp !== changeStamp("Libraries", "Entries") || sending.has(targetKey(target));
          try {
            const rows = await listLibraryPlacements(target, { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) });
            if (!current()) return;
            if (stale()) row.needsRead = true;
            else {
              row.rows = rows;
              row.stamp = stamp;
              row.unavailable = false;
              row.reconciling = [];
              row.failure = null;
            }
          } catch (error) {
            if (!current()) return;
            if (stale()) row.needsRead = true;
            else if (isUnauthenticatedApiError(error)) {
              authenticationLost = true;
              handleUnauthenticatedApiError(error);
            } else if (isAbortError(error)) {
              row.failure = { content: { ...UNKNOWN, title: "libraries couldn’t be loaded" }, onRetry: () => void read(target) };
            } else {
              try {
                const content = libraryRequestErrorMessage(error, { title: "libraries couldn’t be loaded", request: "EntryRead" });
                row.unavailable = isApiError(error) && (error.code === "E_MEDIA_NOT_FOUND" || error.code === "E_NOT_FOUND");
                if (row.unavailable) row.reconciling = [];
                row.failure = { content, onRetry: row.unavailable ? null : () => void read(target) };
              } catch {
                defect = error;
              }
            }
          }
        } while (current() && row.needsRead && !authenticationLost && !sending.has(targetKey(target)));
      } finally {
        if (current()) {
          row.loading = false;
          row.readPromise = null;
          changed();
          prune();
        }
      }
    };
    row.readPromise = run();
    return row.readPromise;
  }
  function acknowledge(target: LibraryPlacementTarget) {
    for (const listener of acknowledgements) {
      try { listener(target); }
      catch (error) { defect = error; }
    }
  }
  function resolve(id: string, result: boolean) {
    observers.get(id)?.(result);
    observers.delete(id);
  }
  function afterCreation(id: string, content: FeedbackContent): FeedbackContent {
    const name = createdForPlacement.get(id);
    return name === undefined ? content : { ...content, message: `“${name}” was created. ${content.message ?? ""}`.trim() };
  }
  function retire(): boolean {
    if (completed.size === 0) return true;
    const remove = new Set(completed.keys());
    for (const entry of work) {
      if (entry.kind === "Placement" && entry.afterCreate !== null && completed.get(entry.afterCreate)?.kind === "CreateRefused") remove.add(workId(entry));
    }
    const next = work.filter((entry) => !remove.has(workId(entry))).map((entry) => {
      if (entry.kind === "Placement" && entry.afterCreate !== null && completed.get(entry.afterCreate)?.kind === "Created") return { ...entry, afterCreate: null };
      return entry;
    });
    try { writePlacementJournal(accountId, next); }
    catch { storageFailure = STORAGE; changed(); return false; }
    const previous = work;
    work = next;
    storageFailure = null;
    for (const entry of previous) {
      const id = workId(entry);
      const outcome = completed.get(id);
      if (!remove.has(id)) continue;
      uncertain.delete(id);
      failures.delete(id);
      if (entry.kind === "Placement" && outcome?.kind === "Placement") {
        const target = commandTarget(entry.request);
        const row = inventory(target);
        row.writes += 1;
        if (outcome.receipt.outcome.kind === "Confirmed") row.reconciling = [...row.reconciling, entry.request];
        else failures.set(id, { content: afterCreation(id, libraryPlacementRefusalMessage(outcome.receipt.outcome.code)), targets: [targetKey(target)] });
        createdForPlacement.delete(id);
        resolve(id, outcome.receipt.outcome.kind === "Confirmed");
        row.needsRead = true;
        acknowledge(target);
      } else if (outcome?.kind === "CreateRefused") {
        const targets = previous.flatMap((child) => child.kind === "Placement" && child.afterCreate === id ? [targetKey(commandTarget(child.request))] : []);
        failures.set(id, { content: outcome.content, targets });
        resolve(id, false);
      } else if (outcome?.kind === "Created" && entry.kind === "CreateLibrary") {
        for (const child of previous) {
          if (child.kind === "Placement" && child.afterCreate === id) createdForPlacement.set(workId(child), entry.request.name);
        }
        resolve(id, true);
      } else resolve(id, false);
    }
    completed.clear();
    if (previous.some((entry) => entry.kind === "Placement" && remove.has(workId(entry)))) publishChange("Entries");
    changed();
    prune();
    return true;
  }
  async function deliver(entry: StoredLibraryWork) {
    const id = workId(entry);
    const target = entry.kind === "Placement" ? commandTarget(entry.request) : null;
    const slot = target === null ? `Create:${id}` : targetKey(target);
    const deliveryEpoch = epoch;
    const wasUncertain = entry.phase === "Sent";
    const next = work.map((item) => workId(item) === id ? { ...item, phase: "Sent" as const } : item);
    try { writePlacementJournal(accountId, next); }
    catch { storageFailure = STORAGE; changed(); return; }
    work = next;
    sending.add(slot);
    if (target) inventory(target).writes += 1;
    uncertain.delete(id);
    failures.delete(id);
    changed();
    try {
      const signal = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
      let outcome: Completion;
      if (entry.kind === "Placement") {
        outcome = { kind: "Placement", receipt: await sendLibraryPlacementCommand(entry.request, { signal }) };
      } else {
        await createLibrary({ libraryId: entry.request.library_id, name: entry.request.name, signal });
        outcome = { kind: "Created" };
      }
      if (!alive || epoch !== deliveryEpoch) return;
      completed.set(id, outcome);
    } catch (error) {
      if (!alive || epoch !== deliveryEpoch) return;
      const createRefusal = entry.kind === "CreateLibrary" && isApiError(error)
        && (error.code === "E_NAME_INVALID" || error.code === "E_INVALID_REQUEST" || error.code === "E_FORBIDDEN")
        ? libraryCreateRefusalMessage(error.code, `couldn’t create “${entry.request.name}”`) : null;
      if (createRefusal !== null && !wasUncertain) {
        completed.set(id, { kind: "CreateRefused", content: createRefusal });
      } else {
        uncertain.add(id);
        const content = entry.kind === "CreateLibrary" ? { ...UNKNOWN, title: `creation not confirmed: “${entry.request.name}”` } : afterCreation(id, UNKNOWN);
        failures.set(id, { content, targets: target ? [targetKey(target)] : work.flatMap((item) => item.kind === "Placement" && item.afterCreate === id ? [targetKey(commandTarget(item.request))] : []) });
        resolve(id, false);
        if (target) acknowledge(target);
        if (isUnauthenticatedApiError(error)) {
          authenticationLost = true;
          handleUnauthenticatedApiError(error);
        } else if (createRefusal === null && !isAbortError(error) && !(isApiError(error) && apiTransportFeedback(error, "") !== null)) {
          // Preserve the sent identity, but surface malformed replies and other
          // same-system defects at the boundary instead of disguising them as a network loss.
          defect = error;
        }
      }
    } finally {
      if (alive && epoch === deliveryEpoch) {
        sending.delete(slot);
        if (completed.size > 0) retire();
        changed();
        pump();
      }
    }
  }
  function pump() {
    if (!alive || !loaded || authenticationLost || storageFailure !== null || defect !== null) return;
    const heads = new Set<string>();
    for (const entry of work) {
      if (storageFailure !== null) break;
      const id = workId(entry);
      const key = entry.kind === "Placement" ? targetKey(commandTarget(entry.request)) : `Create:${id}`;
      if (heads.has(key)) continue;
      heads.add(key);
      if (sending.has(key) || uncertain.has(id) || completed.has(id) || (entry.kind === "Placement" && entry.afterCreate !== null)) continue;
      void deliver(entry);
    }
    for (const row of inventories.values()) {
      if (row.needsRead && !row.loading && !sending.has(targetKey(row.target))) void read(row.target);
    }
  }
  function admit(entries: readonly StoredLibraryWork[]): LibraryWorkAdmission {
    if (!alive || !loaded || authenticationLost || defect !== null || storageFailure !== null) return { kind: "Rejected", feedback: storageFailure ?? STORAGE };
    if (entries.length === 0) return { kind: "Rejected", feedback: { tone: "Neutral", title: "no library changes to make" } };
    const next = [...work, ...entries];
    try { writePlacementJournal(accountId, next); }
    catch { storageFailure = STORAGE; changed(); return { kind: "Rejected", feedback: STORAGE }; }
    work = next;
    const targets = new Set(entries.flatMap((entry) => entry.kind === "Placement" ? [targetKey(commandTarget(entry.request))] : []));
    for (const [id, failure] of failures) {
      if (!work.some((entry) => workId(entry) === id) && failure.targets.some((key) => targets.has(key))) failures.delete(id);
    }
    const commandIds = entries.map(workId);
    const completion = Promise.all(commandIds.map((id) => new Promise<boolean>((done) => observers.set(id, done)))).then((results) => results.every(Boolean));
    changed();
    pump();
    return { kind: "Accepted", commandIds, completion };
  }
  function included(row: Inventory, key: string): boolean {
    const relation = row.rows?.find((option) => libraryPlacementDestinationKey(option.destination) === key)?.relation;
    let value = relation !== undefined && relation.kind !== "Absent";
    for (const command of row.reconciling) if (commandDestination(command) === key) value = isAdd(command);
    for (const entry of work) {
      if (entry.kind !== "Placement" || targetKey(commandTarget(entry.request)) !== targetKey(row.target) || commandDestination(entry.request) !== key) continue;
      const result = completed.get(workId(entry));
      if (result?.kind === "Placement" && result.receipt.outcome.kind === "Refused") continue;
      if (entry.afterCreate !== null && completed.get(entry.afterCreate)?.kind === "CreateRefused") continue;
      value = isAdd(entry.request);
    }
    return value;
  }
  function eligibleTargets(targets: readonly LibraryPlacementTarget[], key: string, desired: boolean) {
    return targets.filter((target) => {
      const row = inventories.get(targetKey(target));
      if (!row?.rows || row.unavailable || included(row, key) === desired) return false;
      const option = row.rows.find((item) => libraryPlacementDestinationKey(item.destination) === key);
      return option?.availability.kind === "Available" && option.relation.kind !== "Inherited";
    });
  }
  function canCreate(targets: readonly LibraryPlacementTarget[]): boolean {
    return targets.length > 0 && targets.every((target) => {
      const row = inventories.get(targetKey(target));
      return row !== undefined && row.rows !== null && !row.loading && !row.needsRead && !row.unavailable
        && row.failure === null && row.stamp === changeStamp("Libraries", "Entries");
    });
  }
  function showRejection(content: FeedbackContent, keys: readonly string[]) {
    failures.set("Admission", { content, targets: keys });
    changed();
    return "Rejected" as const;
  }
  const owner = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getDefect: () => defect,
    start() {
      if (alive) return;
      alive = true;
      epoch += 1;
      if (!loaded) {
        try { work = readPlacementJournal(accountId); loaded = true; invalidJournal = false; storageFailure = null; }
        catch { invalidJournal = true; storageFailure = { ...STORAGE, message: "the saved library work could not be read. repair the record before resuming." }; }
      }
      changed();
      pump();
    },
    stop() {
      alive = false;
      epoch += 1;
      sending.clear();
      for (const id of observers.keys()) resolve(id, false);
      for (const row of inventories.values()) {
        row.generation += 1;
        row.loading = false;
        row.readPromise = null;
        row.needsRead = true;
      }
    },
    watch(targets: readonly LibraryPlacementTarget[], visible: boolean) {
      const unique = new Map(targets.map((target) => [targetKey(target), target]));
      for (const target of unique.values()) {
        const row = inventory(target);
        row.readers += 1;
        if (visible) row.visibleReaders += 1;
        if (row.rows === null || row.stamp !== changeStamp("Libraries", "Entries")) void read(target);
      }
      changed();
      return () => {
        for (const key of unique.keys()) {
          const row = inventories.get(key);
          if (row) {
            row.readers -= 1;
            if (visible) row.visibleReaders -= 1;
          }
        }
        prune();
        changed();
      };
    },
    refresh() { for (const row of inventories.values()) if (row.readers > 0 || row.reconciling.length > 0) void read(row.target); },
    async ensurePlacements(targets: readonly LibraryPlacementTarget[]): Promise<() => void> {
      const release = owner.watch(targets, false);
      try {
        await Promise.all(targets.map(read));
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
    subscribeAcknowledgements(listener: (target: LibraryPlacementTarget) => void) { acknowledgements.add(listener); return () => { acknowledgements.delete(listener); }; },
    retry(id?: string) {
      if (!alive || authenticationLost) return;
      if (storageFailure !== null) {
        if (invalidJournal) {
          try { work = readPlacementJournal(accountId); loaded = true; invalidJournal = false; storageFailure = null; }
          catch { return; }
        } else if (completed.size > 0) {
          if (!retire()) return;
        } else {
          // Admission or Queued→Sent storage failed. Nothing was accepted/sent
          // by that failure; preserve every previously admitted command verbatim.
          try { writePlacementJournal(accountId, work); storageFailure = null; }
          catch { return; }
        }
      }
      for (const key of [...uncertain]) if (id === undefined || id === key) uncertain.delete(key);
      changed();
      pump();
    },
    admitPlacement({ targets, destination, operation }: { targets: readonly LibraryPlacementTarget[]; destination: LibraryPlacementDestination; operation: "Add" | "Remove" }): LibraryWorkAdmission {
      const unique = new Map(targets.map((target) => [targetKey(target), target]));
      const key = libraryPlacementDestinationKey(destination);
      for (const target of unique.values()) {
        const row = inventories.get(targetKey(target));
        if (!row?.rows || row.unavailable) return { kind: "Rejected", feedback: row?.failure?.content ?? { tone: "Warning", title: "load the current libraries before changing them" } };
      }
      const entries = eligibleTargets([...unique.values()], key, operation === "Add").map((target): StoredLibraryWork => ({
        kind: "Placement", phase: "Queued", request: placementCommand(target, destination, operation === "Add"), afterCreate: null,
      }));
      return admit(entries);
    },
    admitCreateAndPlace({ targets, name }: { targets: readonly LibraryPlacementTarget[]; name: string }): LibraryWorkAdmission {
      name = name.trim();
      if (Array.from(name).length < 1 || Array.from(name).length > 100 || isReservedLibraryName(name) || work.some((entry) => entry.kind === "CreateLibrary" && entry.request.name.toLowerCase() === name.toLowerCase())) return { kind: "Rejected", feedback: { tone: "Warning", title: "choose a valid name or review the pending creation" } };
      const library_id = crypto.randomUUID();
      const destination: LibraryPlacementDestination = { kind: "Library", library: { id: library_id, name } };
      const unique = new Map(targets.map((target) => [targetKey(target), target]));
      if (!canCreate([...unique.values()])) return { kind: "Rejected", feedback: { tone: "Warning", title: "load the current libraries before creating one" } };
      if ([...unique.keys()].some((key) => inventories.get(key)?.rows?.some((option) => option.destination.kind === "Library" && option.destination.library.name.trim().toLowerCase() === name.toLowerCase()))) {
        return { kind: "Rejected", feedback: { tone: "Warning", title: "select the existing library with this name" } };
      }
      return admit([
        { kind: "CreateLibrary", phase: "Queued", request: { library_id, name } },
        ...[...unique.values()].map((target): StoredLibraryWork => ({ kind: "Placement", phase: "Queued", request: placementCommand(target, destination, true), afterCreate: library_id })),
      ]);
    },
    view(targets: readonly LibraryPlacementTarget[], mode: "Add" | "Remove" | null): LibraryPlacementView {
      const unique = new Map(targets.map((target) => [targetKey(target), target]));
      const keys = new Set(unique.keys());
      const rows = [...unique.keys()].map((key) => inventories.get(key));
      const known = rows.length > 0 && rows.every((row) => row?.rows !== null && row !== undefined && !row.unavailable);
      const options = new Map<string, LibraryPlacementOption>();
      for (const row of rows) for (const option of row?.rows ?? []) options.set(libraryPlacementDestinationKey(option.destination), option);
      const plans = new Map<string, string[]>();
      const items: LibraryChooserItem[] = [...options].map(([key, option]) => {
        const matches = rows.map((row) => row?.rows?.find((item) => libraryPlacementDestinationKey(item.destination) === key));
        const choiceKnown = known && matches.every((item) => item !== undefined);
        const confirmed = choiceKnown ? matches.filter((item) => item !== undefined && item.relation.kind !== "Absent").length : null;
        const intended = choiceKnown ? rows.filter((row) => row !== undefined && included(row, key)).length : null;
        const desired = mode === null ? intended !== rows.length : mode === "Add";
        const exclusions = new Map<LibraryChooserItem["exclusions"][number]["reason"], number>();
        let targetCount = 0;
        for (const row of rows) {
          if (!row?.rows || included(row, key) === desired) continue;
          const item = row.rows.find((item) => libraryPlacementDestinationKey(item.destination) === key);
          const reason = item?.relation.kind === "Inherited" ? "Inherited" : item?.availability.kind === "Blocked" ? item.availability.reason : null;
          if (reason !== null) exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
          else if (item) targetCount += 1;
        }
        plans.set(key, eligibleTargets([...unique.values()], key, desired).map(targetKey));
        const pending = work.filter((entry) => entry.kind === "Placement" && keys.has(targetKey(commandTarget(entry.request))) && commandDestination(entry.request) === key);
        const progress = pending.some((entry) => uncertain.has(workId(entry)) || (entry.kind === "Placement" && entry.afterCreate !== null && uncertain.has(entry.afterCreate))) ? "Uncertain" : pending.length > 0 ? "Pending" : rows.some((row) => row?.reconciling.some((command) => commandDestination(command) === key)) ? "Reconciling" : "Settled";
        const provenance = new Map(matches.flatMap((item) => item?.relation.kind === "Inherited" ? item.relation.provenance.map((library) => [library.id, library] as const) : []));
        return {
          id: key, name: option.destination.kind === "SavedInNexus" ? "saved in nexus" : option.destination.library.name,
          confirmed: confirmed === null ? null : { included: confirmed, total: rows.length },
          intended: intended === null ? null : { included: intended, total: rows.length }, progress,
          exclusions: [...exclusions].map(([reason, count]) => ({ reason, count })),
          provenance: [...provenance.values()],
          action: choiceKnown && targetCount > 0 ? { kind: "Set", included: desired, targetCount } : { kind: "Blocked", reason: !choiceKnown ? "load libraries for every item before changing this selection" : exclusions.size > 0 ? "no eligible change; review this library’s access or inherited placement" : desired ? "already included" : "not included" },
        };
      });
      const failure = storageFailure === null ? [...failures.values()].find((entry) => entry.targets.some((key) => keys.has(key)))?.content ?? null : storageFailure;
      const firstReadFailure = rows.find((row) => row?.failure !== null && row?.failure !== undefined)?.failure ?? null;
      const creations = work.filter((entry) => entry.kind === "CreateLibrary");
      return {
        items, loading: !known && rows.some((row) => row === undefined || row.loading),
        creationAvailable: canCreate([...unique.values()]),
        summary: `current libraries: ${items.filter((item) => (item.confirmed?.included ?? 0) > 0).map((item) => item.name).join(", ") || "none"}`,
        error: failure ? { content: failure, onRetry: work.some((entry) => relevant(entry, keys) && uncertain.has(workId(entry))) || storageFailure !== null ? () => owner.retry() : null } : firstReadFailure,
        pendingNames: creations.map((entry) => entry.request.name),
        status: creations.length > 0
          ? creations.map((entry) => uncertain.has(workId(entry)) ? `creation not confirmed: “${entry.request.name}”` : `creating “${entry.request.name}”…`).join(" ")
          : work.some((entry) => relevant(entry, keys)) ? "library changes pending" : undefined,
        onCommit: ({ choiceId, included: desired }: { choiceId: string; included: boolean }): "Accepted" | "Rejected" => {
          const option = options.get(choiceId);
          const shown = items.find((item) => item.id === choiceId);
          const latestRows = [...unique.keys()].map((key) => inventories.get(key));
          const latestKnown = latestRows.every((row) => row !== undefined && !row.unavailable && row.rows?.some((item) => libraryPlacementDestinationKey(item.destination) === choiceId));
          const latestDesired = mode === null ? latestRows.some((row) => row !== undefined && !included(row, choiceId)) : mode === "Add";
          const planned = plans.get(choiceId);
          const current = eligibleTargets([...unique.values()], choiceId, desired).map(targetKey);
          if (!option || shown?.action.kind !== "Set" || shown.action.included !== desired || !latestKnown || latestDesired !== desired || current.length === 0 || planned?.join(",") !== current.join(",")) {
            return showRejection({ tone: "Warning", title: "library choices changed; review the current action" }, [...keys]);
          }
          const result = owner.admitPlacement({ targets: [...unique.values()], destination: option.destination, operation: desired ? "Add" : "Remove" });
          if (result.kind === "Rejected") return showRejection(result.feedback, [...keys]);
          return result.kind;
        },
        onCreate: (name: string): "Accepted" | "Rejected" => {
          const result = owner.admitCreateAndPlace({ targets: [...unique.values()], name });
          return result.kind === "Rejected" ? showRejection(result.feedback, [...keys]) : result.kind;
        },
      };
    },
    attention() {
      if (storageFailure !== null) {
        const inline = [...inventories.values()].some((row) => row.visibleReaders > 0);
        return { content: inline ? null : storageFailure, retry: true };
      }
      const unattended = [...failures].filter(([, failure]) => !failure.targets.some((key) => (inventories.get(key)?.visibleReaders ?? 0) > 0));
      if (unattended.length === 0) return { content: null, retry: false };
      const count = unattended.length;
      const content: FeedbackContent = {
        tone: "Warning", title: "library changes need attention",
        message: `${count} library ${count === 1 ? "change needs" : "changes need"} review. ${unattended[0][1].content.message ?? unattended[0][1].content.title}`,
      };
      return { content, retry: unattended.some(([id]) => uncertain.has(id)) };
    },
  };
  return owner;
}

type PlacementOwner = ReturnType<typeof createPlacementOwner>;
const LibraryPlacementContext = createContext<(PlacementOwner & { openLibraryPlacement(target: LibraryPlacementTarget, options: LibraryPlacementOpenOptions): void }) | null>(null);

export function LibraryPlacementControllerProvider({ children }: { children: ReactNode }) {
  const { accountId } = useAuthenticatedAccount();
  const feedback = useFeedback();
  const owner = useMemo(() => createPlacementOwner(accountId), [accountId]);
  const [openedSession, setSession] = useState<(LibraryPlacementSession & { accountId: string }) | null>(null);
  const session = openedSession?.accountId === accountId ? openedSession : null;
  const key = useRef(0);
  const stamp = useChangeStamp("Libraries", "Entries");
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => { owner.start(); return () => owner.stop(); }, [owner]);
  useEffect(() => owner.refresh(), [owner, stamp]);
  const value = useMemo(() => ({ ...owner, openLibraryPlacement(target: LibraryPlacementTarget, options: LibraryPlacementOpenOptions) { setSession({ accountId, key: ++key.current, target, options }); } }), [accountId, owner]);
  useEffect(() => {
    const noticeKey = `library-work:${accountId}`;
    const attention = owner.attention();
    if (attention.content) feedback.publish({ kind: "Persistent", key: noticeKey, content: attention.content, announcement: "Polite", actions: attention.retry ? [{ label: "retry", onClick: () => owner.retry() }] : undefined });
    else feedback.resolve(noticeKey);
  }, [owner, snapshot, accountId, feedback]);
  useEffect(() => () => feedback.resolve(`library-work:${accountId}`), [accountId, feedback]);
  const defect = owner.getDefect();
  if (defect !== null) throw defect;
  return <LibraryPlacementContext.Provider value={value}>{children}<LibraryPlacementOverlay session={session} onClose={() => setSession(null)} /></LibraryPlacementContext.Provider>;
}

function usePlacementOwner() {
  const owner = useContext(LibraryPlacementContext);
  if (owner === null) throw new Error("LibraryPlacementControllerProvider is missing");
  return owner;
}

export type LibraryPlacementController = Pick<PlacementOwner,
  "admitPlacement" | "admitCreateAndPlace" | "ensurePlacements" | "retry" | "subscribeAcknowledgements"
> & { openLibraryPlacement(target: LibraryPlacementTarget, options: LibraryPlacementOpenOptions): void };

export function useLibraryPlacementController(): LibraryPlacementController {
  return usePlacementOwner();
}

export function useLibraryPlacements(targets: readonly LibraryPlacementTarget[], mode: "Add" | "Remove" | null = null) {
  const owner = usePlacementOwner();
  useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const unique = new Map(targets.map((target) => [targetKey(target), target]));
  const key = [...unique.keys()].sort().join(",");
  const scope = useRef({ key, targets: [...unique.values()] });
  if (scope.current.key !== key) scope.current = { key, targets: [...unique.values()] };
  const stableTargets = scope.current.targets;
  const current = useRef({ owner, key, mode });
  current.current = { owner, key, mode };
  useEffect(() => owner.watch(stableTargets, true), [owner, stableTargets]);
  const view = owner.view(stableTargets, mode);
  const stillCurrent = () => current.current.owner === owner && current.current.key === key && current.current.mode === mode;
  return {
    ...view,
    onCommit: (change: Parameters<LibraryPlacementView["onCommit"]>[0]) => stillCurrent() ? view.onCommit(change) : "Rejected" as const,
    onCreate: (name: string) => stillCurrent() ? view.onCreate(name) : "Rejected" as const,
  };
}
