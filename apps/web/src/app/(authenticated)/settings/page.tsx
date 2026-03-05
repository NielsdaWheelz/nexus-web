"use client";

import { ArrowRight, BookOpen, KeyRound, ShieldCheck } from "lucide-react";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

export default function SettingsPage() {
  return (
    <PageLayout
      title="Settings"
      description="Account-level controls and integration configuration."
    >
      <SectionCard
        title="Integrations"
        description="Bring-your-own-key provider credentials."
      >
        <AppList>
          <AppListItem
            href="/settings/keys"
            icon={<KeyRound size={18} />}
            title="API Keys"
            description="Configure OpenAI, Anthropic, and Gemini keys."
            trailing={<ArrowRight size={16} className={styles.arrow} aria-hidden="true" />}
          />
        </AppList>
      </SectionCard>

      <SectionCard
        title="Reader"
        description="Typography, theme, and layout preferences."
      >
        <AppList>
          <AppListItem
            href="/settings/reader"
            icon={<BookOpen size={18} />}
            title="Reader Settings"
            description="Theme, font, line height, column width, focus mode."
            trailing={<ArrowRight size={16} className={styles.arrow} aria-hidden="true" />}
          />
        </AppList>
      </SectionCard>

      <SectionCard
        title="Security"
        description="Baseline account posture."
      >
        <AppList>
          <AppListItem
            title="Session Security"
            icon={<ShieldCheck size={18} />}
            description="Signed-in state and server-side auth checks are active."
          />
        </AppList>
      </SectionCard>
    </PageLayout>
  );
}
