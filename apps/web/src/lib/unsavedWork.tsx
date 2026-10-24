"use client";

// One account's synchronous loss decision. Owners retain their own input and
// requests; this registry reads their current risks and never stores either.
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { securityTeardownStarted } from "@/lib/auth/UnauthenticatedApiBoundary";
import { hasUnsettledWriting } from "@/lib/notes/writes";

export type WorkRisk = Readonly<{
  changed: boolean;
  unconfirmed: boolean;
  stopsBrowserWork: boolean;
}>;
export type WorkScope =
  | { kind: "account" }
  | { kind: "pane"; paneId: string }
  | { kind: "visit"; visitId: string; routeKey: string }
  | { kind: "surface"; id: string };
export interface WorkOwner {
  readonly id: string;
  readonly scope: WorkScope;
  read(): WorkRisk;
  subscribe(listener: () => void): () => void;
}
export interface WorkGuard {
  register(owner: WorkOwner): () => void;
  confirmLoss(input: { scopes: readonly WorkScope[]; ownerIds: readonly string[] }): boolean;
  confirmDocumentExit(): boolean;
  hasWork(): boolean;
}

function matches(scope: WorkScope, owner: WorkScope): boolean {
  switch (scope.kind) {
    case "account": return true;
    case "pane": return owner.kind === "pane" && owner.paneId === scope.paneId;
    case "visit": return owner.kind === "visit" && owner.visitId === scope.visitId && owner.routeKey === scope.routeKey;
    case "surface": return owner.kind === "surface" && owner.id === scope.id;
  }
}

function createWorkRegistry() {
  const owners = new Map<string, { owner: WorkOwner; unsubscribe: () => void }>();
  let active = true;
  let listening = false;
  let signingOut: object | null = null;
  let signOutUnload = false;
  let previousInert: boolean | null = null;
  const risk = (selected: (owner: WorkOwner) => boolean): WorkRisk => {
    let changed = false, unconfirmed = false, stopsBrowserWork = false;
    for (const { owner } of owners.values()) {
      if (!selected(owner)) continue;
      const current = owner.read();
      changed ||= current.changed;
      unconfirmed ||= current.unconfirmed;
      stopsBrowserWork ||= current.stopsBrowserWork;
    }
    return { changed, unconfirmed, stopsBrowserWork };
  };
  const risky = (value: WorkRisk) => value.changed || value.unconfirmed || value.stopsBrowserWork;
  const refresh = () => {
    const needed = active && (signOutUnload || risky(risk(() => true)));
    if (needed === listening) return;
    listening = needed;
    if (needed) window.addEventListener("beforeunload", beforeUnload);
    else window.removeEventListener("beforeunload", beforeUnload);
  };
  function beforeUnload(event: BeforeUnloadEvent) {
    if (signOutUnload) {
      signOutUnload = false;
      refresh();
      return;
    }
    if (securityTeardownStarted() || !risky(risk(() => true))) return;
    event.preventDefault();
    event.returnValue = "";
  }
  const confirm = (value: WorkRisk): boolean => {
    if (securityTeardownStarted()) return true;
    if (!active) return false;
    if (!risky(value)) return true;
    return window.confirm([
      value.changed ? "unsaved changes may be lost." : null,
      value.unconfirmed ? "a request is unconfirmed. it may already have started work." : null,
      value.stopsBrowserWork ? "unfinished uploads and other browser work will stop." : null,
      value.unconfirmed || value.stopsBrowserWork ? "accepted server work is not cancelled." : null,
      "leave anyway?",
    ].filter(value => value !== null).join("\n\n"));
  };
  const guard: WorkGuard = {
    register(owner) {
      owners.get(owner.id)?.unsubscribe();
      const record = { owner, unsubscribe: () => {} };
      owners.set(owner.id, record);
      record.unsubscribe = owner.subscribe(refresh);
      refresh();
      return () => {
        if (owners.get(owner.id) !== record) return;
        owners.delete(owner.id);
        record.unsubscribe();
        refresh();
      };
    },
    confirmLoss: ({ scopes, ownerIds }) => confirm(risk(owner =>
      ownerIds.includes(owner.id) || scopes.some(scope => matches(scope, owner.scope)))),
    confirmDocumentExit: () => confirm(risk(() => true)),
    hasWork: () => risky(risk(() => true)),
  };
  const restore = () => {
    signingOut = null;
    signOutUnload = false;
    if (previousInert !== null) document.body.inert = previousInert;
    previousInert = null;
    refresh();
  };
  const requestExit = (event: Event) => {
    if (!guard.confirmDocumentExit()) event.preventDefault();
  };
  return {
    guard,
    async signOut(purge: () => Promise<void>, submit: () => void): Promise<boolean> {
      if (!active || signingOut || !guard.confirmDocumentExit()) return false;
      const operation = {};
      signingOut = operation;
      previousInert = document.body.inert;
      document.body.inert = true;
      try {
        await purge();
        if (!active || signingOut !== operation) return false;
        signOutUnload = true;
        refresh();
        submit();
        return true;
      } catch (error) {
        if (signingOut === operation) restore();
        throw error;
      }
    },
    mount() {
      active = true;
      refresh();
      window.addEventListener("pageshow", restore);
      document.addEventListener("nexus:request-exit", requestExit);
      return () => {
        active = false;
        window.removeEventListener("pageshow", restore);
        document.removeEventListener("nexus:request-exit", requestExit);
        restore();
        for (const record of owners.values()) record.unsubscribe();
        owners.clear();
      };
    },
  };
}

const WorkContext = createContext<ReturnType<typeof createWorkRegistry> | null>(null);

export function WorkProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createWorkRegistry);
  useLayoutEffect(() => registry.mount(), [registry]);
  return <WorkContext value={registry}>{children}</WorkContext>;
}

export function useWorkGuard(): WorkGuard {
  const registry = useContext(WorkContext);
  if (!registry) throw new Error("useWorkGuard requires WorkProvider");
  return registry.guard;
}

/** Elective signout alone can suppress its already-approved first unload. */
export function useGuardedSignOut() {
  const registry = useContext(WorkContext);
  if (!registry) throw new Error("useGuardedSignOut requires WorkProvider");
  return registry.signOut;
}

/** Automatic exits also retain admitted explicit writing, without adding a user-exit warning. */
export function reloadStrandsWriting(guard: WorkGuard): boolean {
  return guard.hasWork() || hasUnsettledWriting();
}
