"use client";

import styles from "./Tabsbar.module.css";

export interface Tab {
  id: string;
  title: string;
  type: "library" | "media";
}

interface TabsbarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

export default function Tabsbar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
}: TabsbarProps) {
  return (
    <div className={styles.tabsbar}>
      <div className={styles.tabs}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`${styles.tab} ${activeTabId === tab.id ? styles.active : ""}`}
            onClick={() => onTabClick(tab.id)}
          >
            <span className={styles.icon}>
              {tab.type === "library" ? "📚" : "📄"}
            </span>
            <span className={styles.title}>{tab.title}</span>
            <button
              className={styles.closeBtn}
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
              aria-label={`Close ${tab.title}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
