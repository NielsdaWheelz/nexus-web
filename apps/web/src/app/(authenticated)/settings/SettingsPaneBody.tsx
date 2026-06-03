"use client";

import { ArrowRight } from "lucide-react";
import SectionCard from "@/components/ui/SectionCard";
import { AppList, AppListItem } from "@/components/ui/AppList";
import { isAndroidShell, isAndroidShellRestrictedHref } from "@/lib/androidShell";
import { getPaneRouteIcon } from "@/lib/panes/paneRouteTable";
import styles from "./page.module.css";

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
    description: "Configure OpenAI, Anthropic, Gemini, and DeepSeek keys.",
  },
  {
    href: "/settings/appearance",
    title: "Appearance",
    description: "Light, dark, or follow your operating system.",
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
  const androidShell = isAndroidShell();
  const settingsItems = SETTINGS_ITEMS.filter(({ href }) => {
    if (!androidShell) {
      return true;
    }
    return !isAndroidShellRestrictedHref(href);
  });

  return (
    <SectionCard>
      <AppList>
        {settingsItems.map(({ href, title, description }) => {
          const Icon = getPaneRouteIcon(href);
          return (
            <AppListItem
              key={href}
              href={href}
              icon={<Icon size={18} />}
              title={title}
              description={description}
              trailing={<ArrowRight size={16} className={styles.arrow} aria-hidden="true" />}
            />
          );
        })}
      </AppList>
    </SectionCard>
  );
}
