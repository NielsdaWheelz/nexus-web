"use client";

import { Fragment, useEffect, useState } from "react";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { setAppearanceAction } from "@/lib/theme/setAppearanceAction";
import type { AppTheme } from "@/lib/theme/cookie";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
// Imported directly by the one surface that draws it: the inscription registry
// is data-heavy and must never enter a shared barrel (blueprint §3). This pane
// body is a lazy chunk (paneRenderRegistry), so it costs no First Load JS.
import { elvishInscriptions } from "@/lib/theme/elvishInscriptions";
import styles from "./page.module.css";

type Selection = AppTheme | "system";

// The room a doorway looks into. "system" has no room of its own — there is no
// `prefers-color-scheme: elvish` and the OS knows only day and night — so its
// plate is built from the two rooms the OS can name.
type Room = "light" | "dark" | "elvish" | "system";

const DOORWAYS: { value: Selection; room: Room; name: string; hint: string }[] = [
  {
    value: "light",
    room: "light",
    name: "Study",
    hint: "Warm paper, dark ink — day.",
  },
  {
    value: "dark",
    room: "dark",
    name: "Press",
    hint: "Near-black canvas, warm ink — night.",
  },
  {
    value: "elvish",
    room: "elvish",
    name: "Solar",
    hint: "Green twilight, brass ink — dusk.",
  },
  {
    value: "system",
    room: "system",
    name: "System",
    hint: "Match your operating-system preference.",
  },
];

const INSCRIPTION = elvishInscriptions.elenSila;

export default function SettingsAppearancePaneBody() {
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    const value = document.cookie.match(
      /(?:^|;\s*)nx-theme=(light|dark|elvish)/,
    )?.[1];
    setSelection(
      value === "light" || value === "dark" || value === "elvish"
        ? value
        : "system",
    );
  }, []);
  usePaneReturnReady(selection !== null);

  async function handleChange(next: Selection) {
    setSelection(next);
    if (next === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = next;
    }
    await setAppearanceAction(next);
  }

  if (selection === null) return null;

  return (
    <PaneSurface>
      <PaneSection title="Theme">
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Choose how Nexus looks.</legend>
          {DOORWAYS.map((doorway) => (
            <label key={doorway.value} className={styles.doorway}>
              <Plate room={doorway.room} />
              <span className={styles.caption}>
                <input
                  type="radio"
                  name="appearance"
                  value={doorway.value}
                  checked={selection === doorway.value}
                  onChange={() => handleChange(doorway.value)}
                />
                <span className={styles.name}>{doorway.name}</span>
              </span>
              <span className={styles.hint}>{doorway.hint}</span>
              {/* The plaque's caption, hidden from the accessible name so the
                  radio still announces exactly "Solar" and its hint; the
                  colophon below carries the Latin as real, readable text. */}
              {doorway.room === "elvish" ? (
                <span className={styles.latinCaption} aria-hidden="true">
                  {INSCRIPTION.latin}
                </span>
              ) : null}
            </label>
          ))}
        </fieldset>
      </PaneSection>

      <PaneSection
        title="Colophon"
        description="The Solar — the room at the top of the stair; green dusk, one brass lamp, and a book left open."
      >
        <div className={styles.colophon}>
          <Inscription className={styles.inscription} />
          <p className={styles.latin}>{INSCRIPTION.latin}</p>
          <p className={styles.translation}>{INSCRIPTION.translation}</p>
          <dl className={styles.workings}>
            <dt>Language</dt>
            <dd>{INSCRIPTION.language}</dd>
            <dt>Mode</dt>
            <dd>{INSCRIPTION.mode}</dd>
            {INSCRIPTION.transcriptions.map((transcription) => (
              <Fragment key={transcription.engine}>
                <dt>Engine</dt>
                <dd>
                  {transcription.engine} — {transcription.settings}
                </dd>
              </Fragment>
            ))}
            <dt>Verified</dt>
            <dd>{INSCRIPTION.verifiedAgainst}</dd>
            <dt>Transcribed</dt>
            <dd>
              {INSCRIPTION.transcribedAt} · {INSCRIPTION.reviewer}
            </dd>
          </dl>
        </div>
      </PaneSection>
    </PaneSurface>
  );
}

// A miniature elevation of one room, painted by the real theme mechanism: the
// plate carries that room's `data-theme`, so every token below repaints
// natively and this file holds no colour of its own. Decorative — the room's
// name and hint beside it carry the meaning.
function Plate({ room }: { room: Room }) {
  if (room === "system") {
    return (
      <span className={styles.plate} data-theme="light" aria-hidden="true">
        <PlateLines />
        {/* The OS knows day and night, so the plate is both, cut on one
            diagonal. The night half repeats the day half's geometry exactly,
            so the lines run across the seam and only their room changes. */}
        <span className={styles.nightHalf} data-theme="dark">
          <PlateLines />
        </span>
      </span>
    );
  }
  return (
    <span className={styles.plate} data-theme={room} aria-hidden="true">
      {room === "elvish" ? <span className={styles.lamp} /> : null}
      <PlateLines />
      {room === "elvish" ? (
        <Inscription className={styles.plaque} />
      ) : null}
    </span>
  );
}

function PlateLines() {
  return (
    <>
      <span className={`${styles.line} ${styles.lineFirst}`} />
      <span className={`${styles.line} ${styles.lineSecond}`} />
      <span className={`${styles.line} ${styles.lineThird}`} />
      <span className={styles.accentLine} />
    </>
  );
}

// Baked outlines, never a font (direction §5). The English beside it carries
// the meaning, so the drawing is `aria-hidden` and unfocusable.
function Inscription({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox={INSCRIPTION.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      {INSCRIPTION.paths.map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  );
}
