"use client";

import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useId } from "react";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import Select from "@/components/ui/Select";
import Toggle from "@/components/ui/Toggle";
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
  const ready = useRemoteAdmission() === "Ready";
  const p = reader.profile;
  // one radio group per pane: two reader settings panes may be open
  const group = useId();
  usePaneReturnReady(true);

  return (
    <PaneSurface>
      <PaneSection title="Appearance">
        <fieldset className={styles.form} aria-label="reader settings" disabled={!ready}>
          <div className={styles.pair}>
            <label className={styles.field}>
              <span className={styles.label}>Theme</span>
              <Select
                value={p.theme}
                onChange={(e) =>
                  reader.setTheme(e.target.value as ReaderProfile["theme"])
                }
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Font</span>
              <Select
                value={p.font_family}
                onChange={(e) =>
                  reader.setFontFamily(
                    e.target.value as ReaderProfile["font_family"],
                  )
                }
              >
                <option value="serif">Serif</option>
                <option value="sans">Sans-serif</option>
              </Select>
            </label>
          </div>
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
          <fieldset className={styles.segments} role="radiogroup">
            <legend className={styles.label}>Focus mode</legend>
            {FOCUS_MODES.map((mode) => (
              <label key={mode.value}>
                <input
                  type="radio"
                  name={group}
                  value={mode.value}
                  checked={p.focus_mode === mode.value}
                  onChange={() => reader.setFocusMode(mode.value)}
                />
                {mode.label}
              </label>
            ))}
          </fieldset>
          <Toggle
            checked={p.hyphenation === "auto"}
            onCheckedChange={(on) => reader.setHyphenation(on ? "auto" : "off")}
            label="Hyphenation on narrow screens"
          />
          {reader.persistence.state === "Pending" ? (
            <FeedbackStatus content={{ tone: "Neutral", title: "saving reader settings…" }} announcement="Polite" />
          ) : reader.persistence.state === "SaveFailed" ? (
            <FeedbackNotice content={{ tone: "Warning", title: "reader settings not synced", message: "your settings are applied in this tab. retry to sync them." }}
              announcement="None" actions={[{ label: "retry", onClick: reader.retrySave }]} />
          ) : null}
        </fieldset>
      </PaneSection>
    </PaneSurface>
  );
}
