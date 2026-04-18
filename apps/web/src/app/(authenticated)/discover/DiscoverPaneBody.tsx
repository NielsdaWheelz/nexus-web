"use client";

import { Link2, Mic, Upload } from "lucide-react";
import SectionCard from "@/components/ui/SectionCard";
import { AppList, AppListItem } from "@/components/ui/AppList";
import { dispatchOpenAddContent } from "@/components/CommandPalette";
import styles from "./page.module.css";

export default function DiscoverPaneBody() {
  const openUpload = () => {
    dispatchOpenAddContent("content");
  };

  const openPodcastSearch = () => {
    dispatchOpenAddContent("podcast");
  };

  return (
    <>
      <SectionCard
        title="Browse"
        description="Find new sources before you subscribe or ingest."
      >
        <AppList>
          <AppListItem
            icon={<Mic size={18} />}
            title="Add podcast"
            description="Search global podcast feeds and open shows in-app."
            actions={
              <button
                type="button"
                className={styles.rowActionButton}
                onClick={openPodcastSearch}
              >
                Open Add
              </button>
            }
          />
        </AppList>
      </SectionCard>
      <SectionCard
        title="Import"
        description="Bring new sources into Nexus without filing them under Discover."
      >
        <div className={styles.ingestActions}>
          <button type="button" className={styles.ingestButton} onClick={openUpload}>
            <span className={styles.ingestIcon} aria-hidden="true">
              <Upload size={18} />
            </span>
            <span className={styles.ingestTitle}>Upload file</span>
            <span className={styles.ingestDescription}>
              Add PDFs, EPUBs, and other supported files.
            </span>
          </button>
          <button type="button" className={styles.ingestButton} onClick={openUpload}>
            <span className={styles.ingestIcon} aria-hidden="true">
              <Link2 size={18} />
            </span>
            <span className={styles.ingestTitle}>Add from URL</span>
            <span className={styles.ingestDescription}>
              Save an article, video, or feed from a link.
            </span>
          </button>
        </div>
      </SectionCard>
    </>
  );
}
