"use client";

import { useReaderContext } from "@/lib/reader";
import type { CSSProperties, ReactNode } from "react";
import styles from "./ReaderContentArea.module.css";

interface ReaderContentAreaProps {
  children: ReactNode;
  /** Optional className for the inner content (e.g. fragments, epub) */
  contentClassName?: string;
}

/**
 * Wraps reflowable reader content (web article, transcript, epub) with
 * typography and theme from the global reader profile. Does not mutate global
 * app styles.
 */
export default function ReaderContentArea({
  children,
  contentClassName,
}: ReaderContentAreaProps) {
  const { profile } = useReaderContext();

  const fontFamily =
    profile.font_family === "sans"
      ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif";

  const style = {
    "--reader-font-family": fontFamily,
    "--reader-font-size-px": `${profile.font_size_px}px`,
    "--reader-line-height": String(profile.line_height),
    "--reader-column-width-ch": `${profile.column_width_ch}ch`,
  } as CSSProperties;

  return (
    <div
      className={`${styles.root} ${profile.theme === "dark" ? styles.themeDark : styles.themeLight}`}
      style={style}
      data-reader-theme={profile.theme}
    >
      <div className={contentClassName ?? styles.content}>{children}</div>
    </div>
  );
}
