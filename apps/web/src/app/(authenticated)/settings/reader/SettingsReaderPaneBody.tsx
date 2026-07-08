"use client";

import { useEffect, useState } from "react";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import {
  isReaderFocusMode,
  isReaderFontFamily,
  isReaderTheme,
  type ReaderFocusMode,
} from "@/lib/reader/types";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import Select from "@/components/ui/Select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import Toggle from "@/components/ui/Toggle";
import styles from "./page.module.css";

const FOCUS_MODE_OPTIONS: ReadonlyArray<{ value: ReaderFocusMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "distraction_free", label: "Distraction-free" },
  { value: "paragraph", label: "Paragraph" },
  { value: "sentence", label: "Sentence" },
];

export default function SettingsReaderPaneBody() {
  const {
    profile: p,
    error,
    saving,
    save,
    updateTheme,
    updateFontFamily,
    updateFontSize,
    updateLineHeight,
    updateColumnWidth,
  } = useReaderContext();
  const [mounted, setMounted] = useState(false);
  const disabled = !mounted || saving;

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <PaneSurface opener={<SectionOpener heading="Reader" />}>
      <PaneSection title="Appearance">
        {error && <FeedbackNotice severity="error">{error}</FeedbackNotice>}

        <div className={styles.form}>
        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="theme">
              Theme
            </label>
            <Select
              id="theme"
              value={p.theme}
              onChange={(e) => {
                if (isReaderTheme(e.target.value)) updateTheme(e.target.value);
              }}
              disabled={disabled}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </div>

          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fontFamily">
              Font
            </label>
            <Select
              id="fontFamily"
              value={p.font_family}
              onChange={(e) => {
                if (isReaderFontFamily(e.target.value)) {
                  updateFontFamily(e.target.value);
                }
              }}
              disabled={disabled}
            >
              <option value="serif">Serif</option>
              <option value="sans">Sans-serif</option>
            </Select>
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="fontSize">
              Font size ({p.font_size_px}px)
            </label>
            <input
              id="fontSize"
              type="range"
              min={12}
              max={28}
              value={p.font_size_px}
              onChange={(e) =>
                updateFontSize(Number.parseInt(e.target.value, 10))
              }
              disabled={disabled}
              className={styles.range}
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="lineHeight">
              Line height ({p.line_height})
            </label>
            <input
              id="lineHeight"
              type="range"
              min={1.2}
              max={2.2}
              step={0.1}
              value={p.line_height}
              onChange={(e) =>
                updateLineHeight(Number.parseFloat(e.target.value))
              }
              disabled={disabled}
              className={styles.range}
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <label className={styles.formLabel} htmlFor="columnWidth">
              Column width ({p.column_width_ch} ch)
            </label>
            <input
              id="columnWidth"
              type="range"
              min={40}
              max={120}
              value={p.column_width_ch}
              onChange={(e) =>
                updateColumnWidth(Number.parseInt(e.target.value, 10))
              }
              disabled={disabled}
              className={styles.range}
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <span className={styles.formLabel}>Focus mode</span>
            <Tabs
              value={p.focus_mode}
              onValueChange={(next) => {
                if (isReaderFocusMode(next)) save({ focus_mode: next });
              }}
              variant="segmented"
            >
              <TabsList aria-label="Focus mode">
                {FOCUS_MODE_OPTIONS.map((option) => (
                  <TabsTrigger
                    key={option.value}
                    value={option.value}
                    disabled={disabled}
                  >
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formField}>
            <Toggle
              checked={p.hyphenation === "auto"}
              onCheckedChange={(checked) =>
                save({ hyphenation: checked ? "auto" : "off" })
              }
              disabled={disabled}
              label="Hyphenation on narrow screens"
            />
          </div>
        </div>

        {saving && <p className={styles.savingHint}>Saving...</p>}
        </div>
      </PaneSection>
    </PaneSurface>
  );
}
