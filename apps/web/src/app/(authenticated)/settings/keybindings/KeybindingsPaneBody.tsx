"use client";

import CollectionView from "@/components/collections/CollectionView";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { formatShortcut, outlineShortcuts, PANE_STRIP_SHORTCUTS, SHORTCUTS } from "@/lib/shortcuts";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

export default function KeybindingsPaneBody() {
  const { platform } = useRenderEnvironment();
  usePaneReturnReady(true);

  return (
    <PaneSurface>
      <PaneSection description="Shortcuts are fixed. Find destinations and quick actions in Nexus.">
        <CollectionView
          returnScope="Settings.Keybindings.Commands"
          rows={Object.entries(SHORTCUTS).map(([id, shortcut]) =>
            presentSettingsRow({
              presentation: "Details",
              id,
              title: shortcut.label,
              description: shortcut.description,
              meta: formatShortcut(shortcut, platform),
            }),
          )}
          status="ready"
          ariaLabel="Keyboard shortcuts"
          surface={false}
        />
      </PaneSection>
      <PaneSection
        title="Pane strip"
        description="These shortcuts apply while a pane title or one of its controls in the desktop strip has focus. Drag a title to reorder panes."
      >
        <CollectionView
          returnScope="Settings.Keybindings.PaneStrip"
          rows={PANE_STRIP_SHORTCUTS.map(item => presentSettingsRow({ ...item, presentation: "Details" }))}
          status="ready"
          ariaLabel="Pane strip shortcuts"
          surface={false}
        />
      </PaneSection>
      <PaneSection title="outline" description="these keys apply while editing or selecting a block. touch screens offer six buttons for indentation, movement, undo and redo.">
        <CollectionView
          returnScope="Settings.Keybindings.Outline"
          rows={outlineShortcuts(platform).map(item => presentSettingsRow({...item, presentation: "Details"}))}
          status="ready"
          ariaLabel="outline shortcuts"
          surface={false}
        />
      </PaneSection>
    </PaneSurface>
  );
}
