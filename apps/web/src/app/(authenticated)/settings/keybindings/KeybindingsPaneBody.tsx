"use client";

import { useCallback, useEffect, useState } from "react";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import Button from "@/components/ui/Button";
import {
  formatKeyCombo,
  captureKeyCombo,
  DEFAULT_KEYBINDINGS,
} from "@/lib/keybindings";
import { useKeybindingsController } from "@/lib/keybindingsProvider";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
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
  { id: "pane-next", label: "Next pane" },
  { id: "pane-previous", label: "Previous pane" },
];

export default function KeybindingsPaneBody() {
  const { bindings, setBinding, resetBindings } = useKeybindingsController();
  const { platform } = useRenderEnvironment();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [capturedCombo, setCapturedCombo] = useState<string | null>(null);

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
    setBinding(capturing, capturedCombo);
    setCapturing(null);
    setCapturedCombo(null);
  }, [capturing, capturedCombo, setBinding]);

  const clearBinding = useCallback(
    (actionId: string) => {
      setBinding(actionId, null);
    },
    [setBinding],
  );

  const resetAll = useCallback(() => {
    resetBindings();
    setCapturing(null);
    setCapturedCombo(null);
  }, [resetBindings]);

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
    <PaneSurface>
      <PaneSection
        actions={
          <Button variant="ghost" size="sm" onClick={resetAll}>
            Reset to defaults
          </Button>
        }
      >
        <ResourceList>
          {BINDABLE_ACTIONS.map(({ id, label }) => {
            const isCapturing = capturing === id;
            const currentCombo = bindings[id];

            return (
              <ResourceRow
                key={id}
                primary={{ kind: "static" }}
                title={label}
                meta={
                  isCapturing ? (
                    <span className={styles.captureHint}>
                      {capturedCombo
                        ? formatKeyCombo(capturedCombo, platform)
                        : "Press a key combination..."}
                    </span>
                  ) : (
                    <span className={styles.combo}>
                      {currentCombo ? formatKeyCombo(currentCombo, platform) : "—"}
                    </span>
                  )
                }
                description={
                  isCapturing && conflict ? (
                    <span className={styles.conflict}>
                      Already bound to{" "}
                      {BINDABLE_ACTIONS.find((a) => a.id === conflict[0])?.label ??
                        conflict[0]}
                    </span>
                  ) : undefined
                }
                actions={
                  isCapturing ? (
                    <span className={styles.rowActions}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!capturedCombo}
                        onClick={saveCapture}
                      >
                        {conflict ? "Reassign" : "Save"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={cancelCapture}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <span className={styles.rowActions}>
                      <Button variant="ghost" size="sm" onClick={() => startCapture(id)}>
                        Edit
                      </Button>
                      {currentCombo && currentCombo !== DEFAULT_KEYBINDINGS[id] ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => clearBinding(id)}
                        >
                          Clear
                        </Button>
                      ) : null}
                    </span>
                  )
                }
              />
            );
          })}
        </ResourceList>
      </PaneSection>
    </PaneSurface>
  );
}
