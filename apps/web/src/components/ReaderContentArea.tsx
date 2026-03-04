"use client";

import { useReaderContext } from "@/lib/reader";
import type { CSSProperties, ReactNode } from "react";
import type { ReaderProfile } from "@/lib/reader/types";
import styles from "./ReaderContentArea.module.css";

interface ReaderContentAreaProps {
  children: ReactNode;
  /** Optional className for the inner content (e.g. fragments, epub) */
  contentClassName?: string;
  /** Effective per-document settings from /media/{id}/reader-state */
  profileOverride?: Partial<ReaderProfile> | null;
}

/**
 * Wraps reader content (web article, epub) with typography and theme
 * from reader profile. Does not mutate global app styles.
 */
export default function ReaderContentArea({
  children,
  contentClassName,
  profileOverride = null,
}: ReaderContentAreaProps) {
  const { profile } = useReaderContext();
  const effectiveProfile: ReaderProfile = {
    ...profile,
    ...(profileOverride ?? {}),
  };

  const fontFamily =
    effectiveProfile.font_family === "sans"
      ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif";

  const themeClass =
    effectiveProfile.theme === "dark"
      ? styles.themeDark
      : effectiveProfile.theme === "sepia"
        ? styles.themeSepia
        : styles.themeLight;

  const style = {
    "--reader-font-family": fontFamily,
    "--reader-font-size-px": `${effectiveProfile.font_size_px}px`,
    "--reader-line-height": String(effectiveProfile.line_height),
    "--reader-column-width-ch": `${effectiveProfile.column_width_ch}ch`,
  } as CSSProperties;

  return (
    <div
      className={`${styles.root} ${themeClass}`}
      style={style}
      data-reader-theme={effectiveProfile.theme}
    >
      <div className={contentClassName ?? styles.content}>{children}</div>
    </div>
  );
}
