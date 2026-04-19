"use client";

import { useCallback, useEffect, useState } from "react";
import SectionCard from "@/components/ui/SectionCard";
import {
  loadKeybindings,
  saveKeybindings,
  formatKeyCombo,
  captureKeyCombo,
  DEFAULT_KEYBINDINGS,
} from "@/lib/keybindings";
import styles from "./page.module.css";

interface BindableAction {
  id: string;
  label: string;
}

const BINDABLE_ACTIONS: BindableAction[] = [
  { id: "open-palette", label: "Open command palette" },
  { id: "nav-libraries", label: "Go to Libraries" },
  { id: "nav-browse", label: "Go to Browse" },
  { id: "nav-podcasts", label: "Go to Podcasts" },
  { id: "nav-chats", label: "Go to Chats" },
  { id: "nav-search", label: "Go to Search" },
  { id: "nav-settings", label: "Go to Settings" },
  { id: "create-conversation", label: "New conversation" },
  { id: "create-library", label: "New library" },
  { id: "create-upload", label: "Upload file" },
  { id: "create-url", label: "Add from URL" },
];

export default function KeybindingsPaneBody() {
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [capturedCombo, setCapturedCombo] = useState<string | null>(null);

  useEffect(() => {
    setBindings(loadKeybindings());
  }, []);

  const startCapture = useCallback((actionId: string) => {
    setCapturing(actionId);
    setCapturedCombo(null);
  }, []);

  const cancelCapture = useCallback(() => {
    setCapturing(null);
    setCapturedCombo(null);
  }, []);

  const saveCapture = useCallback(() => {
    if (!capturing || !capturedCombo) return;
    const next = { ...bindings, [capturing]: capturedCombo };
    setBindings(next);
    saveKeybindings(next);
    setCapturing(null);
    setCapturedCombo(null);
  }, [bindings, capturing, capturedCombo]);

  const clearBinding = useCallback(
    (actionId: string) => {
      const next = { ...bindings };
      delete next[actionId];
      setBindings(next);
      saveKeybindings(next);
    },
    [bindings],
  );

  const resetAll = useCallback(() => {
    setBindings({ ...DEFAULT_KEYBINDINGS });
    saveKeybindings({ ...DEFAULT_KEYBINDINGS });
    setCapturing(null);
    setCapturedCombo(null);
  }, []);

  // Capture key combo when in capture mode
  useEffect(() => {
    if (!capturing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = captureKeyCombo(e);
      if (combo) setCapturedCombo(combo);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [capturing]);

  // Check for conflicts
  const conflict = capturedCombo
    ? Object.entries(bindings).find(
        ([id, combo]) => combo === capturedCombo && id !== capturing,
      )
    : null;

  return (
    <SectionCard
      actions={
        <button type="button" className={styles.resetBtn} onClick={resetAll}>
          Reset to defaults
        </button>
      }
    >
      <div className={styles.list}>
        {BINDABLE_ACTIONS.map(({ id, label }) => {
          const isCapturing = capturing === id;
          const currentCombo = bindings[id];

          return (
            <div key={id} className={styles.row}>
              <span className={styles.actionLabel}>{label}</span>

              {isCapturing ? (
                <div className={styles.captureRow}>
                  <span className={styles.captureHint}>
                    {capturedCombo
                      ? formatKeyCombo(capturedCombo)
                      : "Press a key combination..."}
                  </span>
                  {conflict && (
                    <span className={styles.conflict}>
                      Already bound to{" "}
                      {BINDABLE_ACTIONS.find((a) => a.id === conflict[0])?.label ??
                        conflict[0]}
                    </span>
                  )}
                  <div className={styles.captureActions}>
                    <button
                      type="button"
                      className={styles.saveBtn}
                      disabled={!capturedCombo}
                      onClick={saveCapture}
                    >
                      {conflict ? "Reassign" : "Save"}
                    </button>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      onClick={cancelCapture}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className={styles.bindingRow}>
                  <span className={styles.combo}>
                    {currentCombo ? formatKeyCombo(currentCombo) : "—"}
                  </span>
                  <button
                    type="button"
                    className={styles.editBtn}
                    onClick={() => startCapture(id)}
                  >
                    Edit
                  </button>
                  {currentCombo && currentCombo !== DEFAULT_KEYBINDINGS[id] && (
                    <button
                      type="button"
                      className={styles.clearBtn}
                      onClick={() => clearBinding(id)}
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
