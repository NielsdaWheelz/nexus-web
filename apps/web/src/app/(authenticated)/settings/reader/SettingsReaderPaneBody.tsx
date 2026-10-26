"use client";

import { Moon, Sun } from "lucide-react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import RadioGroup from "@/components/ui/RadioGroup";
import Toggle from "@/components/ui/Toggle";
import { READER_FONT_STACKS } from "@/lib/documentReader/DocumentReader";
import {
  useReaderContext,
  type ReaderProfile,
} from "@/lib/reader/ReaderContext";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const FOCUS_MODES: readonly {
  value: ReaderProfile["focus_mode"];
  label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "distraction_free", label: "Distraction-free" },
  { value: "paragraph", label: "Paragraph" },
  { value: "sentence", label: "Sentence" },
];

/** The reader profile's seven fields; ReaderProvider owns and saves them. */
export default function SettingsReaderPaneBody() {
  const reader = useReaderContext();
  const p = reader.profile;
  usePaneReturnReady(true);

  return (
    <PaneSurface>
      <PaneSection title="Appearance">
        {!reader.editable ? (
          <FeedbackNotice content={{ tone: "Neutral", title: "changing reader settings requires a connection" }} announcement="Polite" />
        ) : null}
        <fieldset className={styles.form} aria-label="reader settings" disabled={!reader.editable}>
          <RadioGroup
            label="Theme"
            presentation="Segmented"
            value={p.theme}
            choices={[
              { value: "light", label: "Light", icon: <Sun size={16} aria-hidden="true" /> },
              { value: "dark", label: "Dark", icon: <Moon size={16} aria-hidden="true" /> },
            ]}
            onChange={reader.setTheme}
          />
          <RadioGroup
            label="Font"
            presentation="Segmented"
            value={p.font_family}
            choices={[
              { value: "serif", label: <span style={{ fontFamily: READER_FONT_STACKS.serif }}>Serif</span> },
              { value: "sans", label: <span style={{ fontFamily: READER_FONT_STACKS.sans }}>Sans-serif</span> },
            ]}
            onChange={reader.setFontFamily}
          />
          <label className={styles.field}>
            <span className={styles.label}>Font size ({p.font_size_px}px)</span>
            <input
              type="range"
              className={styles.range}
              min={12}
              max={28}
              value={p.font_size_px}
              onChange={(e) => reader.setFontSize(Number(e.target.value))}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Line height ({p.line_height})</span>
            <input
              type="range"
              className={styles.range}
              min={1.2}
              max={2.2}
              step={0.1}
              value={p.line_height}
              onChange={(e) => reader.setLineHeight(Number(e.target.value))}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>
              Column width ({p.column_width_ch} ch)
            </span>
            <input
              type="range"
              className={styles.range}
              min={40}
              max={120}
              value={p.column_width_ch}
              onChange={(e) => reader.setColumnWidth(Number(e.target.value))}
            />
          </label>
          <RadioGroup
            label="Focus mode"
            presentation="Segmented"
            value={p.focus_mode}
            choices={FOCUS_MODES}
            onChange={reader.setFocusMode}
          />
          <Toggle
            checked={p.hyphenation === "auto"}
            onCheckedChange={(on) => reader.setHyphenation(on ? "auto" : "off")}
            label="Hyphenation on narrow screens"
          />
          {reader.persistence.state === "Pending" ? (
            <FeedbackStatus content={{ tone: "Neutral", title: "saving reader settings…" }} announcement="Polite" />
          ) : null}
        </fieldset>
      </PaneSection>
    </PaneSurface>
  );
}
