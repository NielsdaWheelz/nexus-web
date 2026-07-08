"use client";

import CollectionView from "@/components/collections/CollectionView";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { isAndroidShellRestrictedHref } from "@/lib/androidShell";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";

const SETTINGS_ITEMS: {
  href: string;
  title: string;
  description: string;
}[] = [
  {
    href: "/settings/billing",
    title: "Billing",
    description: "Manage your plan, usage, and Stripe subscription.",
  },
  {
    href: "/settings/keys",
    title: "API Keys",
    description: "Configure OpenAI, Anthropic, Gemini, and OpenRouter keys.",
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
    href: "/settings/local-vault",
    title: "Local Vault",
    description: "Connect a local Markdown folder that Nexus keeps current.",
  },
  {
    href: "/settings/identities",
    title: "Linked Identities",
    description: "Connect or remove Google and GitHub sign-in methods.",
  },
];

export default function SettingsPaneBody() {
  const androidShell = useAndroidShell();
  const settingsItems = SETTINGS_ITEMS.filter(({ href }) => {
    if (!androidShell) {
      return true;
    }
    return !isAndroidShellRestrictedHref(href);
  });

  return (
    <CollectionView
      rows={settingsItems.map((item) =>
        presentSettingsRow({
          title: item.title,
          description: item.description,
          href: item.href,
          icon: getPaneRouteIcon(item.href),
        }),
      )}
      view="list"
      density="comfortable"
      status="ready"
      ariaLabel="Settings"
    />
  );
}
