"use client";

import CollectionView from "@/components/collections/CollectionView";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { getDestination, type DestinationId } from "@/lib/navigation/destinations";

const SECTIONS = [
  {
    id: "account",
    description: "Your name, ways to sign in, calendar and session.",
  },
  {
    id: "librarianSettings",
    description: "The reading brief and what the librarian has written.",
  },
  {
    id: "appearance",
    description: "Study, Press, or Solar.",
  },
  {
    id: "reader",
    description: "Theme, font, line height, column width, focus mode.",
  },
  {
    id: "keybindings",
    description: "The shortcuts for Nexus, pane search, and switching panes.",
  },
] satisfies { id: DestinationId; description: string }[];

export default function SettingsPaneBody() {
  usePaneReturnReady(true);
  return (
    <CollectionView
      returnScope="Settings.Sections"
      rows={SECTIONS.map(({ id, description }) => {
        const { href, label } = getDestination(id);
        return presentSettingsRow({ href, title: label, description, presentation: "Index" });
      })}
      status="ready"
      ariaLabel="Settings"
    />
  );
}
