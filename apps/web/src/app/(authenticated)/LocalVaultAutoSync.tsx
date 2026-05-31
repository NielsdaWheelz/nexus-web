"use client";

import { useEffect } from "react";
import { apiFetch } from "@/lib/api/client";
import { isAndroidShell } from "@/lib/androidShell";
import {
  getVaultAutoSync,
  hasVaultPermission,
  isLocalVaultSupported,
  loadVaultDirectoryHandle,
  readEditableVaultFiles,
  writeVaultPayload,
  type VaultSyncPayload,
} from "@/lib/vault/localVault";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";

let localVaultSyncInFlight: Promise<void> | null = null;
let localVaultSyncSubscriberCount = 0;

function isLocalVaultSyncCancelled(): boolean {
  return localVaultSyncSubscriberCount <= 0;
}

async function runLocalVaultSync(feedback: ReturnType<typeof useFeedback>): Promise<void> {
  const handle = await loadVaultDirectoryHandle();
  if (isLocalVaultSyncCancelled() || !handle) {
    return;
  }

  const permitted = await hasVaultPermission(handle, false);
  if (isLocalVaultSyncCancelled() || !permitted) {
    return;
  }

  const files = await readEditableVaultFiles(handle);
  if (isLocalVaultSyncCancelled()) {
    return;
  }

  const response = await apiFetch<{ data: VaultSyncPayload }>("/api/vault", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
  if (isLocalVaultSyncCancelled()) {
    return;
  }

  await writeVaultPayload(handle, response.data);
  if (isLocalVaultSyncCancelled() || response.data.conflicts.length === 0) {
    return;
  }

  feedback.show({
    severity: "warning",
    title: `${response.data.conflicts.length} Local Vault conflict file${response.data.conflicts.length === 1 ? "" : "s"} written.`,
    dedupeKey: "local-vault-conflicts",
  });
}

export default function LocalVaultAutoSync() {
  const feedback = useFeedback();

  useEffect(() => {
    if (isAndroidShell() || !isLocalVaultSupported() || !getVaultAutoSync()) {
      return;
    }

    localVaultSyncSubscriberCount += 1;

    async function runSync() {
      if (isLocalVaultSyncCancelled() || localVaultSyncInFlight) {
        return;
      }

      const sync = runLocalVaultSync(feedback).catch((error) => {
        if (!isLocalVaultSyncCancelled()) {
          feedback.show(toFeedback(error, { fallback: "Local Vault refresh failed" }));
        }
      });
      localVaultSyncInFlight = sync;
      void sync.finally(() => {
        if (localVaultSyncInFlight === sync) {
          localVaultSyncInFlight = null;
        }
      });
      await sync;
    }

    void runSync();

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void runSync();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      localVaultSyncSubscriberCount = Math.max(0, localVaultSyncSubscriberCount - 1);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [feedback]);

  return null;
}
