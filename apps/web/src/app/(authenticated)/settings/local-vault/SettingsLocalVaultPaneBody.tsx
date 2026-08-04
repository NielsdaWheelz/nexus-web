"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, RefreshCcw, UploadCloud } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import { pluralize } from "@/lib/text/pluralize";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import {
  getVaultAutoSync,
  hasVaultPermission,
  isLocalVaultSupported,
  loadVaultDirectoryHandle,
  pickVaultDirectory,
  readEditableVaultFiles,
  saveVaultDirectoryHandle,
  setVaultAutoSync,
  writeVaultPayload,
  type VaultSyncPayload,
} from "@/lib/vault/localVault";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import Pill from "@/components/ui/Pill";
import Toggle from "@/components/ui/Toggle";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
import {
  localVaultErrorMessage,
  type LocalVaultOperation,
} from "@/lib/vault/localVaultErrorMessage";
import styles from "./page.module.css";

type VaultStatus = "notConnected" | "needsPermission" | "synced" | "syncing" | "conflicts" | "error";

interface LocalVaultInitResult {
  supported: boolean;
  autoSync: boolean;
  directoryHandle: FileSystemDirectoryHandle | null;
  permitted: boolean | null;
}

function statusLabel(status: VaultStatus): string {
  if (status === "notConnected") return "Not connected";
  if (status === "needsPermission") return "Needs permission";
  if (status === "syncing") return "Syncing";
  if (status === "conflicts") return "Conflicts";
  if (status === "error") return "Error";
  return "Synced";
}

function statusVariant(status: VaultStatus) {
  if (status === "synced") return "success" as const;
  if (status === "syncing") return "info" as const;
  if (status === "conflicts" || status === "needsPermission") return "warning" as const;
  if (status === "error") return "danger" as const;
  return "neutral" as const;
}

export default function SettingsLocalVaultPaneBody() {
  const androidShell = useAndroidShell();
  const [supported, setSupported] = useState(true);
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [autoSync, setAutoSyncState] = useState(false);
  const [status, setStatus] = useState<VaultStatus>("notConnected");
  const [message, setMessage] = useState("Choose a local folder for your Markdown vault.");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    operation: LocalVaultOperation;
    content: FeedbackContent;
  } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const initResource = useResource<LocalVaultInitResult>({
    cacheKey: androidShell ? null : "settings-local-vault:init",
    load: async () => {
      const localSupported = isLocalVaultSupported();
      const localAutoSync = getVaultAutoSync();
      if (!localSupported) {
        return {
          supported: false,
          autoSync: localAutoSync,
          directoryHandle: null,
          permitted: null,
        };
      }

      const handle = await loadVaultDirectoryHandle();
      if (!handle) {
        return {
          supported: true,
          autoSync: localAutoSync,
          directoryHandle: null,
          permitted: null,
        };
      }

      return {
        supported: true,
        autoSync: localAutoSync,
        directoryHandle: handle,
        permitted: await hasVaultPermission(handle, false),
      };
    },
  });
  usePaneReturnReady(
    androidShell ||
      initResource.status === "ready" ||
      initResource.status === "error",
  );
  const initFailure = useMemo(
    () =>
      initResource.status === "error"
        ? localVaultErrorMessage(initResource.error, "LoadSettings")
        : null,
    [initResource],
  );

  useEffect(() => {
    if (initResource.status === "ready") {
      setSupported(initResource.data.supported);
      setAutoSyncState(initResource.data.autoSync);
      setDirectoryHandle(initResource.data.directoryHandle);
      setFailure(null);
      if (!initResource.data.supported || !initResource.data.directoryHandle) {
        setStatus("notConnected");
        setMessage("Choose a local folder for your Markdown vault.");
        return;
      }
      const permitted = initResource.data.permitted === true;
      setStatus(permitted ? "synced" : "needsPermission");
      setMessage(
        permitted
          ? "Folder connected. Nexus can read and write this vault."
          : "Reconnect folder access to keep this vault current."
      );
      return;
    }

    if (initResource.status === "error") {
      setStatus("error");
      if (initFailure) {
        setFailure({ operation: "LoadSettings", content: initFailure });
      }
    }
  }, [initFailure, initResource]);

  const showError = useCallback((error: unknown, operation: LocalVaultOperation) => {
    if (handleUnauthenticatedApiError(error)) return;
    try {
      const content = localVaultErrorMessage(error, operation);
      if (!content) return;
      setStatus("error");
      setFailure({ operation, content });
    } catch (caughtDefect) {
      setDefect({ error: caughtDefect });
    }
  }, []);

  const connectFolder = useCallback(async () => {
    setFailure(null);
    setBusy(true);
    try {
      const handle = await pickVaultDirectory();
      const permitted = await hasVaultPermission(handle, true);
      if (!permitted) {
        setDirectoryHandle(handle);
        setStatus("needsPermission");
        setMessage("Folder permission was not granted.");
        return;
      }
      await saveVaultDirectoryHandle(handle);
      setDirectoryHandle(handle);
      setStatus("synced");
      setMessage("Folder connected. Nexus can read and write this vault.");
    } catch (error) {
      showError(error, "ConnectFolder");
    } finally {
      setBusy(false);
    }
  }, [showError]);

  const exportVault = useCallback(async () => {
    if (!directoryHandle) {
      setStatus("notConnected");
      setMessage("Connect a local folder first.");
      return;
    }
    setFailure(null);
    setBusy(true);
    setStatus("syncing");
    try {
      if (!(await hasVaultPermission(directoryHandle, true))) {
        setStatus("needsPermission");
        setMessage("Reconnect folder access to keep this vault current.");
        return;
      }
      const response = await apiFetch<{ data: VaultSyncPayload }>("/api/vault");
      await writeVaultPayload(directoryHandle, response.data);
      setStatus(response.data.conflicts.length ? "conflicts" : "synced");
      setMessage(
        response.data.conflicts.length
          ? `${pluralize(response.data.conflicts.length, "conflict file")} written.`
          : "Vault written to the connected folder."
      );
    } catch (error) {
      showError(error, "ExportVault");
    } finally {
      setBusy(false);
    }
  }, [directoryHandle, showError]);

  const syncVault = useCallback(async () => {
    if (!directoryHandle) {
      setStatus("notConnected");
      setMessage("Connect a local folder first.");
      return;
    }
    setFailure(null);
    setBusy(true);
    setStatus("syncing");
    try {
      if (!(await hasVaultPermission(directoryHandle, true))) {
        setStatus("needsPermission");
        setMessage("Reconnect folder access to keep this vault current.");
        return;
      }
      const files = await readEditableVaultFiles(directoryHandle);
      const response = await apiFetch<{ data: VaultSyncPayload }>("/api/vault", {
        method: "POST",
        body: JSON.stringify({ files }),
      });
      await writeVaultPayload(directoryHandle, response.data);
      setStatus(response.data.conflicts.length ? "conflicts" : "synced");
      setMessage(
        response.data.conflicts.length
          ? `${pluralize(response.data.conflicts.length, "conflict file")} written.`
          : `Applied ${pluralize(files.length, "local edit")} and refreshed the folder.`
      );
    } catch (error) {
      showError(error, "SyncVault");
    } finally {
      setBusy(false);
    }
  }, [directoryHandle, showError]);

  const toggleAutoSync = useCallback((checked: boolean) => {
    setVaultAutoSync(checked);
    setAutoSyncState(checked);
  }, []);

  if (defect) throw defect.error;

  if (androidShell) {
    return (
      <PaneSurface>
        <PaneSection>
          <FeedbackNotice
            content={{
              tone: "Info",
              title: "Local Vault isn’t available in the Android app",
              message: "Use a supported desktop browser to connect and sync a local folder.",
            }}
            announcement="None"
          />
        </PaneSection>
      </PaneSurface>
    );
  }

  if (!supported) {
    return (
      <PaneSurface>
        <PaneSection>
          <FeedbackNotice
            content={{
              tone: "Info",
              title: "This browser can’t connect a writable local folder",
              message: "Use a supported desktop browser.",
            }}
            announcement="None"
          />
        </PaneSection>
      </PaneSurface>
    );
  }

  return (
    <PaneSurface>
      <PaneSection>
        <div className={styles.content}>
        {failure ? (
          <FeedbackNotice
            content={failure.content}
            announcement="Assertive"
            actions={[
              {
                label: "Retry",
                onClick:
                  failure.operation === "LoadSettings"
                    ? () => {
                        if (initResource.status === "error") {
                          setFailure(null);
                          initResource.retry();
                        }
                      }
                    : failure.operation === "ConnectFolder"
                      ? () => void connectFolder()
                      : failure.operation === "ExportVault"
                        ? () => void exportVault()
                        : () => void syncVault(),
              },
            ]}
          />
        ) : (
          <div className={styles.statusRow}>
            <Pill tone={statusVariant(status)}>{statusLabel(status)}</Pill>
            <span className={styles.statusText}>{message}</span>
          </div>
        )}

        <div className={styles.buttonRow}>
          <Button
            variant="secondary"
            leadingIcon={<FolderOpen size={16} />}
            onClick={connectFolder}
            disabled={busy}
          >
            Connect folder
          </Button>
          <Button asChild variant="secondary">
            <a
              href="/api/vault/download"
              download="nexus-vault.zip"
              className={styles.downloadLink}
            >
              <Download size={16} />
              Download export
            </a>
          </Button>
          <Button
            variant="secondary"
            leadingIcon={<UploadCloud size={16} />}
            onClick={exportVault}
            disabled={busy || !directoryHandle}
          >
            Export vault
          </Button>
          <Button
            variant="primary"
            leadingIcon={<RefreshCcw size={16} />}
            onClick={syncVault}
            disabled={busy || !directoryHandle}
          >
            Sync now
          </Button>
        </div>

        <Toggle
          checked={autoSync}
          onCheckedChange={toggleAutoSync}
          label="Auto-sync on app load and when this tab becomes active again"
        />
        </div>
      </PaneSection>
    </PaneSurface>
  );
}
