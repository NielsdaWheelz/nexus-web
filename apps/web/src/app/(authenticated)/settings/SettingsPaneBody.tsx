"use client";

import type { ComponentType } from "react";
import { ArrowRight, BookOpen, CreditCard, FolderOpen, KeyRound, Link2 } from "lucide-react";
import SectionCard from "@/components/ui/SectionCard";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const SETTINGS_ITEMS: {
  href: string;
  title: string;
  description: string;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  {
    href: "/settings/billing",
    title: "Billing",
    description: "Manage your plan, usage, and Stripe subscription.",
    Icon: CreditCard,
  },
  {
    href: "/settings/keys",
    title: "API Keys",
    description: "Configure OpenAI, Anthropic, Gemini, and DeepSeek keys.",
    Icon: KeyRound,
  },
  {
    href: "/settings/reader",
    title: "Reader Settings",
    description: "Theme, font, line height, column width, focus mode.",
    Icon: BookOpen,
  },
  {
    href: "/settings/local-vault",
    title: "Local Vault",
    description: "Connect a local Markdown folder that Nexus keeps current.",
    Icon: FolderOpen,
  },
  {
    href: "/settings/identities",
    title: "Linked Identities",
    description: "Connect or remove Google and GitHub sign-in methods.",
    Icon: Link2,
  },
];

export default function SettingsPaneBody() {
  return (
    <SectionCard>
      <AppList>
        {SETTINGS_ITEMS.map(({ href, title, description, Icon }) => (
          <AppListItem
            key={href}
            href={href}
            icon={<Icon size={18} />}
            title={title}
            description={description}
            trailing={<ArrowRight size={16} className={styles.arrow} aria-hidden="true" />}
          />
        ))}
      </AppList>
    </SectionCard>
  );
}
