"use client";

import CollectionView from "@/components/collections/CollectionView";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

const SETTINGS_ITEMS: {
  href: string;
  title: string;
  description: string;
}[] = [
  {
    href: "/settings/account",
    title: "Account",
    description:
      "Manage your email, display name, calendar time zone, and password.",
  },
  {
    href: "/settings/appearance",
    title: "Appearance",
    description: "Study, Press, or follow your operating system.",
  },
  {
    href: "/settings/reader",
    title: "Reader Settings",
    description: "Theme, font, line height, column width, focus mode.",
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
      rows={SETTINGS_ITEMS.map((item) =>
        presentSettingsRow({
          title: item.title,
          description: item.description,
          href: item.href,
        }),
      )}
      status="ready"
      ariaLabel="Settings"
    />
  );
}
