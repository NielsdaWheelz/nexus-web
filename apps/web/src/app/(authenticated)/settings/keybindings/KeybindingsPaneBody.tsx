"use client";

import { useCallback, useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import Button from "@/components/ui/Button";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
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

// Bindable ids match the launcher's resolvable actions: "open-launcher" + the shared
// destination registry ids (lib/navigation/destinations.ts) + workspace pane navigation.
const BINDABLE_ACTIONS: BindableAction[] = [
  { id: "open-launcher", label: "Open launcher" },
  { id: "libraries", label: "Go to Libraries" },
  { id: "authors", label: "Go to Authors" },
  { id: "podcasts", label: "Go to Podcasts" },
  { id: "chats", label: "Go to Chats" },
  { id: "notes", label: "Go to Notes" },
  { id: "today", label: "Go to Today" },
  { id: "oracle", label: "Go to Oracle" },
  { id: "search", label: "Go to Search" },
  { id: "settings", label: "Go to Settings" },
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
  const conflictLabel = conflict
    ? (BINDABLE_ACTIONS.find((a) => a.id === conflict[0])?.label ?? conflict[0])
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
        <CollectionView
          rows={BINDABLE_ACTIONS.map(({ id, label }) => {
            const isCapturing = capturing === id;
            const currentCombo = bindings[id];
            const meta = isCapturing
              ? capturedCombo
                ? formatKeyCombo(capturedCombo, platform)
                : "Press a key combination..."
              : currentCombo
                ? formatKeyCombo(currentCombo, platform)
                : "-";

            return presentSettingsRow({
              id,
              title: label,
              description:
                isCapturing && conflictLabel
                  ? `Already bound to ${conflictLabel}`
                  : undefined,
              meta,
              icon: Keyboard,
            });
          })}
          view="list"
          density="comfortable"
          status="ready"
          ariaLabel="Keyboard shortcuts"
          surface={false}
          rowControls={Object.fromEntries(
            BINDABLE_ACTIONS.map(({ id }) => {
              const isCapturing = capturing === id;
              const currentCombo = bindings[id];

              return [
                id,
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
                ),
              ];
            }),
          )}
          rowActionsVisibility="always"
        />
      </PaneSection>
    </PaneSurface>
  );
}
