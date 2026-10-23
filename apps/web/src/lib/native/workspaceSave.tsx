"use client";
// The one device save loop. Only canonical navigation is serialized. A lost
// commit answer is reconciled against durable bytes before another write.
import { useEffect, useState } from "react";
import { useWorkspaceCondition } from "@/components/feedback/Feedback";
import type { WorkspaceStore } from "@/lib/workspace/store";
import type { WorkspaceState } from "@/lib/workspace/model";
import { readDeviceStartup, saveDeviceWorkspace } from "./client";

export function useDeviceWorkspaceSave(store: WorkspaceStore, local: { initial: WorkspaceState; revision: { current: string } } | null): void {
  const [failure, setFailure] = useState<{ retry: () => void; busy: boolean } | null>(null);
  const initial = local?.initial;
  const revision = local?.revision;
  useWorkspaceCondition("device-workspace-save", failure ? {
    priority: "Write", announcement: "Polite",
    content: { tone: "Warning", title: "workspace changes weren’t saved on this device", message: "keep the app open and retry. reopening may restore an earlier workspace." },
    actions: [{ label: "retry", onClick: failure.retry, busy: failure.busy }],
  } : null);
  useEffect(() => {
    if (!initial || !revision) return;
    let live = true;
    let saved = JSON.stringify(initial);
    let sending = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = async () => {
      clearTimeout(timer);
      if (!live) return;
      if (sending) { queued = true; return; }
      const state = store.value().state;
      const desired = JSON.stringify(state);
      if (desired === saved) return;
      sending = true;
      setFailure(previous => previous ? { ...previous, busy: true } : null);
      try {
        try {
          revision.current = await saveDeviceWorkspace(state, revision.current);
        } catch (error) {
          const committed = (await readDeviceStartup())?.binding;
          if (!committed) throw error;
          revision.current = committed.workspace_revision;
          if (JSON.stringify(committed.workspace) !== desired) throw error;
        }
        saved = desired;
        if (live) setFailure(null);
      } catch {
        if (live) setFailure({ retry: () => void save(), busy: false });
      } finally {
        sending = false;
        if (live && queued) { queued = false; if (JSON.stringify(store.value().state) !== desired) void save(); }
      }
    };
    let scheduled = store.value().state;
    const unsubscribe = store.subscribe(() => {
      const state = store.value().state;
      if (state === scheduled) return;
      scheduled = state;
      clearTimeout(timer);
      timer = setTimeout(() => void save(), 200);
    });
    if (JSON.stringify(scheduled) !== saved) timer = setTimeout(() => void save(), 200);
    const flush = () => { void save(); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      live = false;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [initial, revision, store]);
}
