"use client";

import { useCallback, useEffect, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import Button from "@/components/ui/Button";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import {
  formatKeyCombo,
  captureKeyCombo,
  DEFAULT_KEYBINDINGS,
} from "@/lib/keybindings";
import { useKeybindingsController } from "@/lib/keybindingsProvider";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  getDestination,
  type DestinationId,
} from "@/lib/navigation/destinations";

interface BindableAction {
  id: string;
  label: string;
}

const BINDABLE_DESTINATION_IDS = [
  "lectern",
  "libraries",
  "podcasts",
  "chats",
  "notes",
  "atlas",
  "oracle",
  "authors",
  "search",
  "settings",
] as const satisfies readonly DestinationId[];

// Bindable ids match the launcher's resolvable actions: "open-launcher" + a
// deliberate projection of the shared destination registry + workspace actions.
const BINDABLE_ACTIONS: BindableAction[] = [
  { id: "open-launcher", label: "Open launcher" },
  ...BINDABLE_DESTINATION_IDS.map((id) => ({
    id,
    label: `Go to ${getDestination(id).label}`,
  })),
  { id: "today", label: "Go to Today" },
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
    <PaneSurface opener={<SectionOpener heading="Keyboard Shortcuts" />}>
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
              actions: isCapturing
                ? [
                    {
                      kind: "command",
                      id: "cancel-keybinding-capture",
                      label: "Cancel",
                      onSelect: cancelCapture,
                    },
                  ]
                : currentCombo && currentCombo !== DEFAULT_KEYBINDINGS[id]
                  ? [
                      {
                        kind: "command",
                        id: "clear-keybinding",
                        label: "Clear shortcut",
                        onSelect: () => clearBinding(id),
                      },
                    ]
                  : [],
            });
          })}
          status="ready"
          ariaLabel="Keyboard shortcuts"
          surface={false}
          rowControls={Object.fromEntries(
            BINDABLE_ACTIONS.map(({ id }) => {
              const isCapturing = capturing === id;

              return [
                id,
                isCapturing ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!capturedCombo}
                    onClick={saveCapture}
                  >
                    {conflict ? "Reassign" : "Save"}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => startCapture(id)}>
                    Edit
                  </Button>
                ),
              ];
            }),
          )}
        />
      </PaneSection>
    </PaneSurface>
  );
}
