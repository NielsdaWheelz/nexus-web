"use client";

import CollectionView from "@/components/collections/CollectionView";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

const SECTIONS = [
  {
    href: "/settings/account",
    title: "Account",
    description:
      "Manage your email, display name, calendar time zone, and password.",
  },
  {
    href: "/settings/appearance",
    title: "Appearance",
    description: "Study, Press, or Solar.",
  },
  {
    href: "/settings/reader",
    title: "Reader Settings",
    description: "Theme, font, line height, column width, focus mode.",
  },
  {
    href: "/settings/keybindings",
    title: "Keyboard Shortcuts",
    description: "The shortcuts for Nexus, pane search, and switching panes.",
  },
  {
    href: "/settings/identities",
    title: "Linked Identities",
    description: "Connect or remove Google and GitHub sign-in methods.",
  },
];

export default function SettingsPaneBody() {
  usePaneReturnReady(true);
  return (
    <CollectionView
      returnScope="Settings.Sections"
      rows={SECTIONS.map(item => presentSettingsRow({ ...item, presentation: "Index" }))}
      status="ready"
      ariaLabel="Settings"
    />
  );
}
