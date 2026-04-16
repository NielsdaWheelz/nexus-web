"use client";

import { useEffect } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import {
  getVaultAutoSync,
  hasVaultPermission,
  isLocalVaultSupported,
  loadVaultDirectoryHandle,
  readEditableVaultFiles,
  writeVaultPayload,
  type VaultSyncPayload,
} from "@/lib/vault/localVault";
import { useToast } from "@/components/Toast";

interface VaultResponse {
  data: VaultSyncPayload;
}

export default function LocalVaultAutoSync() {
  const { toast } = useToast();

  useEffect(() => {
    if (!isLocalVaultSupported() || !getVaultAutoSync()) {
      return;
    }

    let cancelled = false;
    let running = false;

    async function runSync() {
      if (cancelled || running) {
        return;
      }
      running = true;
      try {
        const handle = await loadVaultDirectoryHandle();
        if (!handle || !(await hasVaultPermission(handle, false))) {
          return;
        }
        const files = await readEditableVaultFiles(handle);
        const response = await apiFetch<VaultResponse>("/api/vault", {
          method: "POST",
          body: JSON.stringify({ files }),
        });
        await writeVaultPayload(handle, response.data);
        if (response.data.conflicts.length > 0) {
          toast({
            variant: "warning",
            message: `${response.data.conflicts.length} Local Vault conflict file${response.data.conflicts.length === 1 ? "" : "s"} written.`,
          });
        }
      } catch (error) {
        if (!cancelled) {
          toast({
            variant: "error",
            message: isApiError(error)
              ? error.message
              : error instanceof Error
                ? error.message
                : "Local Vault refresh failed",
          });
        }
      } finally {
        running = false;
      }
    }

    void runSync();

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void runSync();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [toast]);

  return null;
}
