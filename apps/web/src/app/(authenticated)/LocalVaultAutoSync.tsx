"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import { pluralize } from "@/lib/text/pluralize";
import {
  getVaultAutoSync,
  hasVaultPermission,
  isLocalVaultSupported,
  loadVaultDirectoryHandle,
  readEditableVaultFiles,
  writeVaultPayload,
  type VaultSyncPayload,
} from "@/lib/vault/localVault";
import { useFeedback } from "@/components/feedback/Feedback";
import { localVaultErrorMessage } from "@/lib/vault/localVaultErrorMessage";

let localVaultSyncInFlight: Promise<LocalVaultSyncOutcome> | null = null;
let localVaultSyncSubscriberCount = 0;

type LocalVaultSyncOutcome = "Complete" | "Unavailable" | "Cancelled";

function isLocalVaultSyncCancelled(): boolean {
  return localVaultSyncSubscriberCount <= 0;
}

async function runLocalVaultSync(
  feedback: ReturnType<typeof useFeedback>,
): Promise<LocalVaultSyncOutcome> {
  const handle = await loadVaultDirectoryHandle();
  if (isLocalVaultSyncCancelled()) return "Cancelled";
  if (!handle) return "Unavailable";

  const permitted = await hasVaultPermission(handle, false);
  if (isLocalVaultSyncCancelled()) return "Cancelled";
  if (!permitted) return "Unavailable";

  const files = await readEditableVaultFiles(handle);
  if (isLocalVaultSyncCancelled()) {
    return "Cancelled";
  }

  const response = await apiFetch<{ data: VaultSyncPayload }>("/api/vault", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
  if (isLocalVaultSyncCancelled()) {
    return "Cancelled";
  }

  await writeVaultPayload(handle, response.data);
  if (isLocalVaultSyncCancelled()) return "Cancelled";
  if (response.data.conflicts.length === 0) return "Complete";

  feedback.publish({
    kind: "Hud",
    key: "local-vault-conflicts",
    content: {
      tone: "Warning",
      title: `${pluralize(response.data.conflicts.length, "Local Vault conflict file")} written`,
      message: "Review the conflict file in the connected folder.",
    },
  });
  return "Complete";
}

const LOCAL_VAULT_FAILURE_KEY = "local-vault-auto-sync-failed";

export default function LocalVaultAutoSync() {
  const feedback = useFeedback();
  const androidShell = useAndroidShell();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    if (androidShell || !isLocalVaultSupported()) {
      return;
    }
    if (!getVaultAutoSync()) {
      feedback.resolve(LOCAL_VAULT_FAILURE_KEY);
      return;
    }

    localVaultSyncSubscriberCount += 1;

    async function runSync() {
      if (isLocalVaultSyncCancelled() || localVaultSyncInFlight) {
        return;
      }

      const sync: Promise<LocalVaultSyncOutcome> = runLocalVaultSync(feedback)
        .then((outcome) => {
          if (!isLocalVaultSyncCancelled() && outcome === "Complete") {
            feedback.resolve(LOCAL_VAULT_FAILURE_KEY);
          }
          return outcome;
        })
        .catch((error) => {
          if (handleUnauthenticatedApiError(error)) return "Unavailable" as const;
          if (!isLocalVaultSyncCancelled()) {
            try {
              const content = localVaultErrorMessage(error, "AutoSync");
              if (!content) {
                setDefect({
                  error: new TypeError(
                    "Auto-sync failure unexpectedly mapped to picker cancellation.",
                  ),
                });
                return "Unavailable" as const;
              }
              feedback.publish({
                kind: "Persistent",
                key: LOCAL_VAULT_FAILURE_KEY,
                content,
                announcement: "Assertive",
                actions: [{ label: "Retry", onClick: () => void runSync() }],
              });
            } catch (caughtDefect) {
              setDefect({ error: caughtDefect });
            }
          }
          return isLocalVaultSyncCancelled()
            ? ("Cancelled" as const)
            : ("Unavailable" as const);
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
  }, [androidShell, feedback]);

  if (defect) throw defect.error;

  return null;
}
