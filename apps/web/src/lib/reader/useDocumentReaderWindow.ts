"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import type { DocumentReaderSession, LeasedReaderUnit, ReaderSessionLoad, ReaderResource, ReaderUnitLease, ReaderViewCapacity } from "./DocumentReaderSession";
import type { ReaderPublicationResolution, ReaderPublicationTarget } from "./publicationContract";

export interface ReaderWindowUnit extends LeasedReaderUnit { readonly lease: ReaderUnitLease }
export type ReaderNavigationCompletion =
  | { readonly kind: "Ready"; readonly item: ReaderWindowUnit; readonly target: Extract<ReaderPublicationResolution, { kind: "Text" | "Unit" }>; isCurrent(): boolean }
  | ReaderViewCapacity
  | Extract<ReaderPublicationResolution, { kind: "Unresolved" }>
  | { readonly kind: "Superseded" }
  | { readonly kind: "Failed"; readonly error: unknown };
export interface DocumentReaderWindow {
  readonly units: readonly ReaderWindowUnit[];
  readonly activeUnit: ReaderWindowUnit | null;
  readonly unitRequest: ReaderResource<null>;
  readonly navigationTarget: { readonly id: number; readonly target: Extract<ReaderPublicationResolution, { kind: "Text" | "Unit" }> } | null;
  readonly capacity: ReaderViewCapacity | null;
  readonly unresolved: Extract<ReaderPublicationResolution, { kind: "Unresolved" }> | null;
  readonly contentDefect: { readonly key: string; readonly error: unknown; retry(): void } | null;
  navigate(target: ReaderPublicationTarget): Promise<ReaderNavigationCompletion>;
  /**
   * Speculation from the resident run that holds the active unit. Views take
   * priority: this issues nothing (and answers null) while an explicit
   * navigation is pending, and a capacity refusal it receives is reported
   * through its completion instead of latching into `capacity`, so a momentary
   * permit shortage never exchanges continuous reading for chapter buttons.
   */
  loadNeighbor(direction: "Previous" | "Next"): Promise<ReaderNavigationCompletion | null>;
  setActiveUnit(lease: ReaderUnitLease): void;
  /** First detach its prepared root; this then returns payload residency. */
  releaseUnit(lease: ReaderUnitLease): boolean;
  retryUnit(): void;
}

interface UnitRequest {
  readonly session: DocumentReaderSession;
  readonly id: number;
  readonly activate: boolean;
  readonly target: ReaderPublicationTarget | Extract<ReaderPublicationResolution, { kind: "Text" | "Unit" }>;
  readonly fallbackUnitKey: string | null;
  readonly commandIsCurrent: (() => boolean) | null;
}
interface UnitWindow {
  readonly session: DocumentReaderSession;
  readonly units: readonly ReaderWindowUnit[];
  readonly active: ReaderUnitLease | null;
}

/** Exact mounted content leases are independent of a platform's progress writer. */
export function useDocumentReaderWindow({ session, initial, retryInitial, retireUnits, captureNavigationAuthority }: {
  readonly session: DocumentReaderSession;
  readonly captureNavigationAuthority?: () => (() => boolean);
  readonly initial: ReaderResource<ReaderSessionLoad>;
  readonly retryInitial: () => void;
  readonly retireUnits: (units: readonly ReaderWindowUnit[]) => boolean;
}): DocumentReaderWindow {
  const retireUnitsRef = useRef(retireUnits);
  retireUnitsRef.current = retireUnits;
  const [window, setWindow] = useState<UnitWindow>({ session, units: [], active: null });
  const windowRef = useRef(window);
  const [request, setRequest] = useState<UnitRequest | null>(null);
  const requestId = useRef(0);
  const explicitNavigationId = useRef(0);
  const settledRequestId = useRef(0);
  /** A refused speculation is re-issued only once the window has moved. */
  const speculationRefusal = useRef<ReaderViewCapacity | null>(null);
  const pendingCompletion = useRef<{ id: number; resolve: (value: ReaderNavigationCompletion) => void } | null>(null);
  const [unitRequest, setUnitRequest] = useState<ReaderResource<null>>({ status: "idle" });
  const [unitDefect, setUnitDefect] = useState<{ session: DocumentReaderSession; id: number; error: unknown } | null>(null);
  const [navigation, setNavigation] = useState<DocumentReaderWindow["navigationTarget"]>(null);
  const [capacity, setCapacity] = useState<ReaderViewCapacity | null>(null);
  const [unresolved, setUnresolved] = useState<Extract<ReaderPublicationResolution, { kind: "Unresolved" }> | null>(null);
  const commitWindow = useCallback((next: UnitWindow) => {
    windowRef.current = next;
    speculationRefusal.current = null;
    setWindow(next);
  }, []);

  useEffect(() => {
    pendingCompletion.current?.resolve({ kind: "Superseded" });
    pendingCompletion.current = null;
    requestId.current += 1;
    explicitNavigationId.current = requestId.current;
    commitWindow({ session, units: [], active: null });
    setRequest(null);
    setNavigation(null);
    setCapacity(null);
    setUnresolved(null);
    return () => {
      explicitNavigationId.current = -1;
      for (const item of windowRef.current.units) {
        item.lease.pin("Selection", false);
        item.lease.pin("Focus", false);
        item.lease.pin("Interaction", false);
        item.lease.release();
      }
      windowRef.current = { session, units: [], active: null };
    };
  }, [session, commitWindow]);

  const initialData = initial.status === "ready" && "document" in initial.data ? initial.data : null;
  const initialCapacity = initial.status === "ready" && "kind" in initial.data ? initial.data : null;
  const initialTarget = initialData !== null && initialData.document.kind !== "Pdf" ? initialData.document.initial : null;
  const initialFallback = initialData !== null && initialData.document.descriptor.kind !== "pdf"
    ? initialData.document.descriptor.first_unit_ref.key : null;
  const currentRequest = request?.session === session ? request : null;
  const requestTarget = currentRequest?.target ?? initialTarget;
  const fallbackUnitKey = currentRequest === null ? initialFallback : currentRequest.fallbackUnitKey;
  useEffect(() => {
    if (requestTarget === null) return;
    const controller = new AbortController();
    const expectedRequest = requestId.current;
    const expectedNavigation = explicitNavigationId.current;
    const explicit = currentRequest?.activate !== false;
    const commandIsCurrent = currentRequest?.commandIsCurrent;
    const complete = (value: ReaderNavigationCompletion) => {
      settledRequestId.current = expectedRequest;
      const pending = pendingCompletion.current;
      if (pending?.id !== expectedRequest) return;
      pendingCompletion.current = null;
      pending.resolve(value);
    };
    // An explicit refusal is the view's state until the reader asks again; a
    // speculative one belongs to its completion, never to the pane's chrome.
    const refuse = (value: ReaderViewCapacity) => {
      if (explicit) setCapacity(value);
      else speculationRefusal.current = value;
      setUnitRequest({ status: "ready", data: null });
      complete(value);
    };
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (requestId.current !== expectedRequest || commandIsCurrent?.() === false) throw new DOMException("Reader request superseded", "AbortError");
    };
    let lease: ReaderUnitLease | null = null;
    let adopted = false;
    setUnitRequest({ status: "loading" });
    setCapacity(null);
    if (explicit) setUnresolved(null);
    void (async () => {
      assertCurrent();
      let resolution = "unit_ref" in requestTarget ? requestTarget : await session.resolve(requestTarget, controller.signal);
      assertCurrent();
      if (resolution.kind === "Unresolved") {
        setUnresolved(resolution);
        if (fallbackUnitKey !== null) {
          resolution = await session.resolve({ kind: "Unit", unit_key: fallbackUnitKey }, controller.signal);
          assertCurrent();
        } else {
          setUnitRequest({ status: "ready", data: null });
          complete(resolution);
          return;
        }
      }
      if (resolution.kind === "Capacity") {
        refuse(resolution);
        return;
      }
      if (!("unit_ref" in resolution)) throw new Error("Text navigation returned no addressed unit");
      const existing = windowRef.current.units.find((item) => item.address.unit_ref.key === resolution.unit_ref.key);
      if (existing !== undefined) {
        if (explicit) {
          commitWindow({ ...windowRef.current, active: existing.lease });
          setNavigation({ id: expectedRequest, target: resolution });
        }
        setUnitRequest({ status: "ready", data: null });
        const currentLease = existing.lease;
        complete({ kind: "Ready", item: existing, target: resolution,
          isCurrent: () => explicitNavigationId.current === expectedNavigation && !currentLease.released && commandIsCurrent?.() !== false });
        return;
      }
      // The session's budget covers transition overlap, so the replacement is
      // admitted while the previous window is still readable. Only a lease or
      // payload shortage retires previous units, farthest from the target
      // first, and a pinned remainder is the sole reason to refuse for pins.
      const ordinal = resolution.ordinal;
      let acquisition = session.acquireUnit(resolution);
      while (explicit && acquisition.kind === "Capacity" && (acquisition.reason === "Leases" || acquisition.reason === "Payload")) {
        const farthest = [...windowRef.current.units].filter((item) => !item.lease.pinned)
          .sort((left, right) => Math.abs(right.address.ordinal - ordinal) - Math.abs(left.address.ordinal - ordinal))[0];
        if (farthest === undefined || !retireUnitsRef.current([farthest])) break;
        if (!farthest.lease.release()) throw new Error("Reader unit became pinned during synchronous retirement");
        commitWindow({ session, units: windowRef.current.units.filter((item) => item !== farthest),
          active: windowRef.current.active === farthest.lease ? null : windowRef.current.active });
        acquisition = session.acquireUnit(resolution);
      }
      if (acquisition.kind === "Capacity") {
        refuse(explicit && acquisition.reason !== "Reads" && windowRef.current.units.some((item) => item.lease.pinned)
          ? { kind: "Capacity", reason: "Pins" } : acquisition);
        return;
      }
      lease = acquisition.lease;
      const value = await lease.promise;
      assertCurrent();
      if (value.kind === "Capacity") {
        refuse(value);
        return;
      }
      const item: ReaderWindowUnit = { kind: value.kind, address: value.address, get unit() { return value.unit; }, lease };
      const replaced = explicit ? windowRef.current.units.filter((resident) => !resident.lease.pinned) : [];
      const detached = replaced.length > 0 && retireUnitsRef.current(replaced);
      if (detached) {
        for (const retired of replaced) {
          if (!retired.lease.release()) throw new Error("Reader unit became pinned during synchronous retirement");
        }
      }
      const retained = detached ? windowRef.current.units.filter((resident) => !replaced.includes(resident)) : windowRef.current.units;
      const units = [...retained, item].sort((left, right) => left.address.ordinal - right.address.ordinal);
      commitWindow({ session, units, active: explicit ? lease : windowRef.current.active });
      adopted = true;
      if (explicit) setNavigation({ id: expectedRequest, target: resolution });
      setUnitRequest({ status: "ready", data: null });
      const currentLease = item.lease;
      complete({ kind: "Ready", item, target: resolution,
        isCurrent: () => explicitNavigationId.current === expectedNavigation && !currentLease.released && commandIsCurrent?.() !== false });
    })().catch((error: unknown) => {
      if (controller.signal.aborted || requestId.current !== expectedRequest) return;
      if (isAbortError(error)) {
        setUnitRequest({ status: "ready", data: null });
        complete({ kind: "Superseded" });
        return;
      }
      if (!isApiError(error) || isSameSystemApiDefect(error)) {
        setUnitRequest({ status: "ready", data: null });
        setUnitDefect({ session, id: expectedRequest, error });
        complete({ kind: "Failed", error });
        return;
      }
      setUnitRequest({ status: "error", error });
      complete({ kind: "Failed", error });
    }).finally(() => {
      if (!adopted) lease?.release();
    });
    return () => {
      controller.abort();
      complete({ kind: "Superseded" });
      if (!adopted) lease?.release();
    };
  }, [requestTarget, currentRequest?.id, currentRequest?.activate, currentRequest?.commandIsCurrent, fallbackUnitKey, session, commitWindow]);

  const navigate = useCallback((target: ReaderPublicationTarget) => {
    const commandIsCurrent = captureNavigationAuthority?.() ?? null;
    requestId.current += 1;
    explicitNavigationId.current = requestId.current;
    speculationRefusal.current = null;
    pendingCompletion.current?.resolve({ kind: "Superseded" });
    const promise = new Promise<ReaderNavigationCompletion>((resolve) => {
      pendingCompletion.current = { id: requestId.current, resolve };
    });
    setRequest({ session, id: requestId.current, target, activate: true, fallbackUnitKey: null, commandIsCurrent });
    return promise;
  }, [captureNavigationAuthority, session]);
  const retryUnit = useCallback(() => {
    const commandIsCurrent = captureNavigationAuthority?.() ?? null;
    requestId.current += 1;
    explicitNavigationId.current = requestId.current;
    speculationRefusal.current = null;
    pendingCompletion.current?.resolve({ kind: "Superseded" });
    pendingCompletion.current = null;
    if (initialCapacity !== null) { retryInitial(); return; }
    if (requestTarget === null) return;
    setRequest({ session, id: requestId.current, target: requestTarget, activate: currentRequest?.activate ?? true, fallbackUnitKey, commandIsCurrent });
  }, [captureNavigationAuthority, requestTarget, session, currentRequest?.activate, fallbackUnitKey, initialCapacity, retryInitial]);
  const loadNeighbor = useCallback((direction: "Previous" | "Next") => {
    if (explicitNavigationId.current === requestId.current && settledRequestId.current !== requestId.current) return Promise.resolve(null);
    const refused = speculationRefusal.current;
    if (refused !== null) return Promise.resolve<ReaderNavigationCompletion>(refused);
    const { units, active } = windowRef.current;
    // Extend the resident run that holds the active unit: a retained pin can
    // leave an unrelated unit at the window's edge.
    let edge = units.find((item) => item.lease === active);
    if (edge === undefined) return Promise.resolve(null);
    let reference = direction === "Previous" ? edge.address.previous_ref : edge.address.next_ref;
    while (reference !== null) {
      const key = reference.key;
      const resident = units.find((item) => item.address.unit_ref.key === key);
      if (resident === undefined) break;
      edge = resident;
      reference = direction === "Previous" ? edge.address.previous_ref : edge.address.next_ref;
    }
    if (reference === null) return Promise.resolve(null);
    pendingCompletion.current?.resolve({ kind: "Superseded" });
    requestId.current += 1;
    const promise = new Promise<ReaderNavigationCompletion>((resolve) => {
      pendingCompletion.current = { id: requestId.current, resolve };
    });
    setRequest({ session, id: requestId.current, target: { kind: "Unit", unit_key: reference.key }, activate: false, fallbackUnitKey: null, commandIsCurrent: null });
    return promise;
  }, [session]);
  const setActiveUnit = useCallback((lease: ReaderUnitLease) => {
    if (!windowRef.current.units.some((item) => item.lease === lease)) throw new Error("Cannot activate an unowned reader unit");
    commitWindow({ ...windowRef.current, active: lease });
  }, [commitWindow]);
  const releaseUnit = useCallback((lease: ReaderUnitLease) => {
    if (!windowRef.current.units.some((item) => item.lease === lease)) return true;
    if (!lease.release()) return false;
    commitWindow({ session, units: windowRef.current.units.filter((item) => item.lease !== lease),
      active: windowRef.current.active === lease ? null : windowRef.current.active });
    return true;
  }, [session, commitWindow]);

  const currentWindow = window.session === session ? window : { units: [], active: null };
  return {
    units: currentWindow.units,
    activeUnit: currentWindow.units.find((item) => item.lease === currentWindow.active) ?? null,
    unitRequest: unitRequest.status === "error" ? { ...unitRequest, retry: retryUnit } : unitRequest,
    navigationTarget: navigation, capacity: initialCapacity ?? capacity, unresolved, navigate, loadNeighbor, setActiveUnit, releaseUnit, retryUnit,
    contentDefect: unitDefect?.session === session && unitDefect.id === requestId.current
      ? { key: `unit:${unitDefect.id}`, error: unitDefect.error, retry: retryUnit } : null,
  };
}
