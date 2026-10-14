"use client";

import CollectionView from "@/components/collections/CollectionView";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { formatShortcut, SHORTCUTS } from "@/lib/shortcuts";
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
    </PaneSurface>
  );
}
