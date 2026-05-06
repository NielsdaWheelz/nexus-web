"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FolderOpen, RefreshCcw, UploadCloud } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { FeedbackNotice, toFeedback } from "@/components/feedback/Feedback";
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
import SectionCard from "@/components/ui/SectionCard";
import StatusPill from "@/components/ui/StatusPill";
import styles from "./page.module.css";

type VaultStatus = "notConnected" | "needsPermission" | "synced" | "syncing" | "conflicts" | "error";

interface VaultResponse {
  data: VaultSyncPayload;
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
  if (status === "error") return "error" as const;
  return "neutral" as const;
}

export default function SettingsLocalVaultPaneBody() {
  const [supported, setSupported] = useState(true);
  const [directoryHandle, setDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [autoSync, setAutoSyncState] = useState(false);
  const [status, setStatus] = useState<VaultStatus>("notConnected");
  const [message, setMessage] = useState("Choose a local folder for your Markdown vault.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupported(isLocalVaultSupported());
    setAutoSyncState(getVaultAutoSync());
    loadVaultDirectoryHandle().then(async (handle) => {
      if (!handle) {
        return;
      }
      setDirectoryHandle(handle);
      const permitted = await hasVaultPermission(handle, false);
      setStatus(permitted ? "synced" : "needsPermission");
      setMessage(
        permitted
          ? "Folder connected. Nexus can read and write this vault."
          : "Reconnect folder access to keep this vault current."
      );
    });
  }, []);

  const showError = useCallback((error: unknown, fallback: string) => {
    setStatus("error");
    setMessage(toFeedback(error, { fallback }).title);
  }, []);

  const connectFolder = useCallback(async () => {
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
      showError(error, "Failed to connect folder");
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
    setBusy(true);
    setStatus("syncing");
    try {
      if (!(await hasVaultPermission(directoryHandle, true))) {
        setStatus("needsPermission");
        setMessage("Reconnect folder access to keep this vault current.");
        return;
      }
      const response = await apiFetch<VaultResponse>("/api/vault");
      await writeVaultPayload(directoryHandle, response.data);
      setStatus(response.data.conflicts.length ? "conflicts" : "synced");
      setMessage(
        response.data.conflicts.length
          ? `${response.data.conflicts.length} conflict file${response.data.conflicts.length === 1 ? "" : "s"} written.`
          : "Vault written to the connected folder."
      );
    } catch (error) {
      showError(error, "Failed to export vault");
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
    setBusy(true);
    setStatus("syncing");
    try {
      if (!(await hasVaultPermission(directoryHandle, true))) {
        setStatus("needsPermission");
        setMessage("Reconnect folder access to keep this vault current.");
        return;
      }
      const files = await readEditableVaultFiles(directoryHandle);
      const response = await apiFetch<VaultResponse>("/api/vault", {
        method: "POST",
        body: JSON.stringify({ files }),
      });
      await writeVaultPayload(directoryHandle, response.data);
      setStatus(response.data.conflicts.length ? "conflicts" : "synced");
      setMessage(
        response.data.conflicts.length
          ? `${response.data.conflicts.length} conflict file${response.data.conflicts.length === 1 ? "" : "s"} written.`
          : `Applied ${files.length} local edit${files.length === 1 ? "" : "s"} and refreshed the folder.`
      );
    } catch (error) {
      showError(error, "Failed to sync vault");
    } finally {
      setBusy(false);
    }
  }, [directoryHandle, showError]);

  const toggleAutoSync = useCallback((checked: boolean) => {
    setVaultAutoSync(checked);
    setAutoSyncState(checked);
  }, []);

  if (!supported) {
    return (
      <SectionCard>
        <FeedbackNotice severity="error">
          This browser cannot connect a writable local folder. Use a supported desktop browser.
        </FeedbackNotice>
      </SectionCard>
    );
  }

  return (
    <SectionCard>
      <div className={styles.content}>
        <div className={styles.statusRow}>
          <StatusPill variant={statusVariant(status)}>{statusLabel(status)}</StatusPill>
          <span className={styles.statusText}>{message}</span>
        </div>

        <div className={styles.buttonRow}>
          <button type="button" className={styles.button} onClick={connectFolder} disabled={busy}>
            <FolderOpen size={16} />
            Connect folder
          </button>
          <a className={styles.button} href="/api/vault/download" download="nexus-vault.zip">
            <Download size={16} />
            Download export
          </a>
          <button
            type="button"
            className={styles.button}
            onClick={exportVault}
            disabled={busy || !directoryHandle}
          >
            <UploadCloud size={16} />
            Export vault
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={syncVault}
            disabled={busy || !directoryHandle}
          >
            <RefreshCcw size={16} />
            Sync now
          </button>
        </div>

        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(event) => toggleAutoSync(event.target.checked)}
          />
          Auto-sync on app load and when this tab becomes active again
        </label>
      </div>
    </SectionCard>
  );
}
