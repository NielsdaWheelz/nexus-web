"use client";

/** Independent playback defaults belong to the account, never a subscription or
 * dialog lifetime. Commands freeze row identity, exact version and desired pair.
 */
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { type ApiError, isApiError, outcomeUnknown } from "@/lib/api/client";
import { invalidateReads, publishChange } from "@/lib/api/changes";
import { modeledApiError, requestWithRetry } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { getPodcastSettings, savePodcastSettings, type PodcastSettings } from "./api";

type Patch = Schema<"PodcastPlaybackSettingsRequest">;
type Command = { readonly patch: Patch };
type Reason = "Conflict" | "Unknown";
type SettingsSave =
  | { readonly kind: "Saving"; readonly command: Command }
  | { readonly kind: "Accepted"; readonly command: Command; readonly current: PodcastSettings }
  | { readonly kind: "Rejected"; readonly command: Command; readonly error: ApiError }
  | { readonly kind: "Unknown"; readonly command: Command; readonly error: ApiError }
  | { readonly kind: "Reading"; readonly command: Command; readonly reason: Reason }
  | { readonly kind: "Review"; readonly command: Command; readonly reason: Reason; readonly current: PodcastSettings }
  | { readonly kind: "ReadFailed"; readonly command: Command; readonly reason: Reason; readonly error: ApiError }
  | { readonly kind: "Absent"; readonly command: Command }
  | { readonly kind: "Replaced"; readonly command: Command };
interface Entry { readonly podcastId: string; readonly ownerId: string; unregister: () => void; state: SettingsSave; busy: boolean }
const EMPTY: readonly Entry[] = [];
function createOwner(accountId: string, guard: WorkGuard, fail: (input: { error: unknown }) => void) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  let lifetime: AbortController | null = null;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const emit = () => { snapshot = [...entries.values()]; for (const listener of listeners) listener(); };
  const current = (entry: Entry, scope: AbortController) => lifetime === scope && !scope.signal.aborted && entries.get(entry.podcastId) === entry;
  async function read(entry: Entry, reason: Reason, scope: AbortController): Promise<PodcastSettings | null> {
    const command = entry.state.command;
    entry.state = { kind: "Reading", command, reason }; emit();
    invalidateReads("Podcasts");
    try {
      const value = await requestWithRetry(signal => getPodcastSettings(entry.podcastId, signal), AbortSignal.any([scope.signal, AbortSignal.timeout(30_000)]));
      if (!current(entry, scope)) return null;
      if (value.id !== null && value.id !== command.patch.id) { entry.state = { kind: "Replaced", command }; emit(); return null; }
      if (reason === "Unknown" && value.id === command.patch.id && value.default_playback_speed === command.patch.default_playback_speed && value.pause_shortening_mode === command.patch.pause_shortening_mode) {
        entry.state = { kind: "Accepted", command, current: value }; emit(); publishChange("Podcasts"); return value;
      }
      entry.state = { kind: "Review", command, reason, current: value }; emit();
    } catch (caught) {
      if (!current(entry, scope)) return null;
      const error = modeledApiError(caught, fail);
      if (error !== null) entry.state = error.code === "E_NOT_FOUND" ? { kind: "Absent", command } : { kind: "ReadFailed", command, reason, error };
      emit();
    }
    return null;
  }
  async function send(entry: Entry): Promise<PodcastSettings | null> {
    const scope = lifetime;
    if (scope === null || scope.signal.aborted || entry.busy) return null;
    const command = entry.state.command;
    entry.busy = true; entry.state = { kind: "Saving", command }; emit();
    try {
      const value = await savePodcastSettings(entry.podcastId, command.patch, AbortSignal.any([scope.signal, AbortSignal.timeout(30_000)]));
      if (!current(entry, scope)) return null;
      entry.state = { kind: "Accepted", command, current: value }; emit(); return value;
    } catch (caught) {
      if (!current(entry, scope)) return null;
      const error = modeledApiError(caught, fail);
      if (error?.status === 409) return await read(entry, "Conflict", scope);
      if (error !== null) entry.state = error.code === "E_NOT_FOUND" ? { kind: "Absent", command } : { kind: outcomeUnknown(error) ? "Unknown" : "Rejected", command, error };
      invalidateReads("Podcasts"); emit(); return null;
    } finally { if (current(entry, scope)) { entry.busy = false; emit(); } }
  }
  return { subscribe, snapshot: () => snapshot,
    start() { const scope = new AbortController(); lifetime = scope; return () => { scope.abort(); if (lifetime !== scope) return; lifetime = null; for (const entry of entries.values()) entry.unregister(); entries.clear(); emit(); }; },
    commands: {
      state: (id: string | null) => id === null ? null : entries.get(id)?.state ?? null,
      ownerId: (id: string | null) => `podcast-settings:${accountId}:${id}`,
      save(id: string, patch: Patch) {
        const old = entries.get(id);
        if (old?.busy || old?.state.kind === "Unknown" || old?.state.kind === "ReadFailed") return Promise.resolve(null);
        old?.unregister();
        const ownerId = `podcast-settings:${accountId}:${id}`;
        const entry: Entry = { podcastId: id, ownerId, state: { kind: "Saving", command: { patch: { ...patch } } }, busy: false,
          unregister: () => {} };
        entry.unregister = guard.register({ id: ownerId, scope: { kind: "account" }, subscribe, read: () => ({ changed: false, unconfirmed: entry.state.kind === "Saving" || entry.state.kind === "Unknown" || ((entry.state.kind === "Reading" || entry.state.kind === "ReadFailed") && entry.state.reason === "Unknown"), stopsBrowserWork: false }) });
        entries.set(id, entry); return send(entry);
      },
      reset(id: string) { const entry = entries.get(id); if (entry === undefined || entry.busy || entry.state.kind === "Unknown" || entry.state.kind === "ReadFailed" || entry.state.kind === "Rejected") return; entries.delete(id); entry.unregister(); emit(); },
      retry(id: string) { const entry = entries.get(id); return entry?.state.kind === "Rejected" ? send(entry) : Promise.resolve(null); },
      async check(id: string) {
        const entry = entries.get(id), scope = lifetime;
        if (scope === null || entry === undefined || entry.busy || (entry.state.kind !== "Unknown" && entry.state.kind !== "ReadFailed")) return null;
        const reason = entry.state.kind === "Unknown" ? "Unknown" : entry.state.reason;
        entry.busy = true;
        try { return await read(entry, reason, scope); } finally { if (current(entry, scope)) { entry.busy = false; emit(); } }
      },
    },
  };
}
export function usePodcastSettingsOwner(accountId: string, fail: (input: { error: unknown }) => void) {
  const guard = useWorkGuard();
  const owner = useMemo(() => createOwner(accountId, guard, fail), [accountId, guard, fail]);
  useLayoutEffect(() => owner.start(), [owner]);
  const entries = useSyncExternalStore(owner.subscribe, owner.snapshot, () => EMPTY);
  return { commands: { ...owner.commands }, feedback: entries.map(entry => <SettingsCondition key={entry.ownerId} entry={entry} check={() => { void owner.commands.check(entry.podcastId); }} />) };
}
function SettingsCondition({ entry, check }: { entry: Entry; check: () => void }) {
  const state = entry.state;
  const uncertain = state.kind === "Unknown" || state.kind === "ReadFailed";
  useWorkspaceCondition(entry.ownerId, uncertain || state.kind === "Saving" || state.kind === "Reading" ? { priority: "Write", announcement: "Polite",
    content: { tone: uncertain ? "Warning" : "Neutral", title: uncertain ? "playback defaults not confirmed" : "saving playback defaults…", requestId: "error" in state && isApiError(state.error) ? state.error.requestId : undefined },
    actions: uncertain ? [{ label: "check saved settings", onClick: check }] : undefined,
  } : null);
  return null;
}
export function usePodcastSettingsSave(podcastId: string | null, subject: string | null) {
  const { ctx } = useActionRuntime();
  const commands = ctx.podcastSettings;
  const state = commands.state(podcastId);
  return { ownerId: commands.ownerId(podcastId), state, busy: state?.kind === "Saving" || state?.kind === "Reading",
    reset: (_settingsId: string | null) => { if (podcastId !== null) commands.reset(podcastId); },
    save: (patch: Patch) => podcastId !== null && subject !== null ? commands.save(podcastId, patch) : Promise.resolve(null),
    retry: () => podcastId === null ? Promise.resolve(null) : commands.retry(podcastId),
    check: () => podcastId === null ? Promise.resolve(null) : commands.check(podcastId),
  };
}
