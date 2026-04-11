"use client";

import type { ComponentType } from "react";
import { ArrowRight, FileText, Mic, Video } from "lucide-react";
import SectionCard from "@/components/ui/SectionCard";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

interface DiscoverCard {
  href: string;
  title: string;
  description: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

const DISCOVER_CARDS: DiscoverCard[] = [
  {
    href: "/documents",
    title: "Documents",
    description: "Review articles, PDFs, and EPUBs across your libraries.",
    Icon: FileText,
  },
  {
    href: "/podcasts",
    title: "Podcasts",
    description: "Search global podcast feeds and inspect episode content already ingested.",
    Icon: Mic,
  },
  {
    href: "/videos",
    title: "Videos",
    description: "Browse video entries, including YouTube ingests.",
    Icon: Video,
  },
];

export default function DiscoverPaneBody() {
  return (
    <>
      <SectionCard>
        <AppList>
          {DISCOVER_CARDS.map(({ href, title, description, Icon }) => (
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
    </>
  );
}
