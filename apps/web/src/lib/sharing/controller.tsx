"use client";

// One account controller owns one sharing session and its exact submitted command.
// Reads settle only the requested grant's desired state. Refused replays retain
// earlier uncertainty; close/replacement deliberately abandon through WorkGuard.
// The loss guard covers dispatch before apiFetch can trigger an automatic reload.
import {createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import ShareOverlay from "@/components/sharing/ShareOverlay";
import type {Retract} from "@/components/feedback/stage";
import {useOutcome} from "@/components/feedback/Feedback";
import {apiFetch, isApiError, outcomeUnknown, type ApiPath} from "@/lib/api/client";
import type {ApiJson, Schema} from "@/lib/api/wire";
import {handleUnauthenticatedApiError} from "@/lib/auth/UnauthenticatedApiBoundary";
import {useWorkGuard} from "@/lib/unsavedWork";
import type {CanonicalResourceRef, ShareOpenOptions, ShareTarget} from "@/lib/sharing/types";

type Snapshot = Schema<"ResourceShareSnapshotOut">;
type Audience = Schema<"CreateResourceShareRequest">["audience"];
type Request = {readonly kind: "Create"; readonly id: string; readonly body: string}
  | {readonly kind: "Revoke"; readonly id: string};
export type ShareChange = {kind: "Created"; share: Snapshot["shares"][number]} | {kind: "Revoked"; id: string};
export interface ShareCommand {
  readonly sessionKey: number;
  readonly subject: CanonicalResourceRef;
  readonly key: string;
  readonly request: Request;
  readonly fact: string;
  readonly running: boolean;
  readonly unknown: number;
}
export interface ShareSession {
  key: number;
  origin: string;
  target: ShareTarget;
  options: ShareOpenOptions;
}
export interface ShareCommands {
  readonly pending: ShareCommand | null;
  create(session: ShareSession, audience: Audience, key: string, fact: string): Promise<ShareChange | null>;
  revoke(session: ShareSession, id: string, fact: string): Promise<ShareChange | null>;
  retry(session: ShareSession): Promise<ShareChange | null>;
  observe(session: ShareSession, snapshot: Snapshot): void;
}
interface ShareController {
  openShare: (target: ShareTarget, options: ShareOpenOptions) => void;
  closeShare: () => void;
}
const ShareControllerContext = createContext<ShareController | null>(null);

export function ShareControllerProvider({children}: {children: ReactNode}) {
  const guard = useWorkGuard();
  const outcome = useOutcome();
  const ownerId = useId();
  const [session, setSession] = useState<ShareSession | null>(null);
  const currentSession = useRef<ShareSession | null>(null);
  const [pending, setPending] = useState<ShareCommand | null>(null);
  const currentCommand = useRef<ShareCommand | null>(null);
  const report = useRef<Retract | null>(null);
  const listeners = useRef(new Set<() => void>());
  const lifetime = useRef(new AbortController());
  const active = useRef(false);
  const nextKey = useRef(0);
  const publish = useCallback((command: ShareCommand | null) => {
    currentCommand.current = command;
    setPending(command);
    for (const listener of listeners.current) listener();
  }, []);
  useLayoutEffect(() => {
    active.current = true;
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const unregister = guard.register({
      id: ownerId, scope: {kind: "surface", id: ownerId},
      read: () => ({changed: false, unconfirmed: currentCommand.current !== null, stopsBrowserWork: currentCommand.current?.running === true}),
      subscribe: listener => { listeners.current.add(listener); return () => {listeners.current.delete(listener);}; },
    });
    return () => { active.current = false; lifetime.current.abort(); unregister(); };
  }, [guard, ownerId]);
  const abandon = useCallback(() => {
    if (!active.current || !guard.confirmLoss({scopes: [], ownerIds: [ownerId]})) return false;
    lifetime.current.abort();
    report.current?.(); report.current = null;
    lifetime.current = new AbortController();
    publish(null);
    return true;
  }, [guard, ownerId, publish]);
  const openShare = useCallback((target: ShareTarget, options: ShareOpenOptions) => {
    if (!abandon()) return;
    const next = {key: ++nextKey.current, origin: document.location.origin, target, options};
    currentSession.current = next;
    setSession(next);
  }, [abandon]);
  const closeShare = useCallback(() => {
    if (!abandon()) return;
    currentSession.current = null;
    setSession(null);
  }, [abandon]);
  const observe = useCallback((session: ShareSession, snapshot: Snapshot) => {
    const command = currentCommand.current;
    if (!active.current || currentSession.current !== session || command === null || command.unknown === 0) return;
    const present = snapshot.shares.some(share => share.id === command.request.id)
      || snapshot.received_access.some(share => share.id === command.request.id);
    if (command.request.kind === "Create" ? present : !present) publish(null);
  }, [publish]);

  async function send(command: ShareCommand): Promise<ShareChange | null> {
    if (!active.current || currentSession.current?.key !== command.sessionKey || command.running) return null;
    const signal = lifetime.current.signal;
    report.current?.(); report.current = null;
    const sending = {...command, running: true};
    publish(sending);
    const owned = () => active.current && !signal.aborted && currentCommand.current === sending
      && currentSession.current?.key === command.sessionKey;
    try {
      let change: ShareChange;
      if (command.request.kind === "Create") {
        const path: ApiPath = `/api/resource-items/${encodeURIComponent(command.subject)}/shares`;
        const {data} = await apiFetch<ApiJson<"/resource-items/{resource_ref}/shares", "post">>(path,
          {method: "POST", body: command.request.body, signal});
        change = {kind: "Created", share: data.share};
      } else {
        await apiFetch(`/api/resource-shares/${command.request.id}`, {method: "DELETE", signal});
        change = {kind: "Revoked", id: command.request.id};
      }
      if (!owned()) return null;
      publish(null);
      return change;
    } catch (error) {
      if (!owned()) return null;
      if (outcomeUnknown(error)) publish({...command, running: false, unknown: command.unknown + 1});
      else {
        publish(command.unknown > 0 ? {...command, running: false, unknown: command.unknown + 1} : null);
        if (!handleUnauthenticatedApiError(error)) {
          if (isApiError(error) && error.code === "E_USER_NOT_FOUND")
            report.current = outcome.say({fact: command.fact, reason: "this account no longer exists."});
          else report.current = outcome.fail(error, command.fact);
        }
      }
      return null;
    }
  }
  function start(session: ShareSession, key: string, request: () => Request, fact: string) {
    if (!active.current || currentSession.current !== session || session.target.kind !== "Resource") return Promise.resolve(null);
    const existing = currentCommand.current;
    if (existing !== null) return existing.key === key ? send(existing) : Promise.resolve(null);
    return send({sessionKey: session.key, subject: session.target.ref, key, request: request(), fact, running: false, unknown: 0});
  }
  const commands: ShareCommands = {
    pending,
    create: (session, audience, key, fact) => start(session, key, () => {
      const id = crypto.randomUUID();
      return {kind: "Create", id, body: JSON.stringify({id, audience})};
    }, fact),
    revoke: (session, id, fact) => start(session, id, () => ({kind: "Revoke", id}), fact),
    retry: session => currentSession.current === session && currentCommand.current !== null ? send(currentCommand.current) : Promise.resolve(null),
    observe,
  };
  const value = useMemo(() => ({openShare, closeShare}), [closeShare, openShare]);
  return <ShareControllerContext.Provider value={value}>
    {children}
    <ShareOverlay session={session} commands={commands} onClose={closeShare}/>
  </ShareControllerContext.Provider>;
}
export function useShareController(): ShareController {
  const value = useContext(ShareControllerContext);
  if (!value) throw new Error("ShareControllerProvider is missing");
  return value;
}
