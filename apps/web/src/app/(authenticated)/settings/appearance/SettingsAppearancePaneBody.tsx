"use client";

import { Fragment, useEffect, useId, useState } from "react";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
// Imported here only: the inscription registry is data-heavy and must stay out
// of shared bundles; this body is a lazy chunk.
import { elvishInscriptions } from "@/lib/theme/elvishInscriptions";
import { parseRoom, ROOM_CHROME, THEME_COOKIE, type AppTheme } from "@/lib/theme/room";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const DOORWAYS: readonly { room: AppTheme; name: string; hint: string }[] = [
  { room: "light", name: "Study", hint: "Warm paper, dark ink — day." },
  { room: "dark", name: "Press", hint: "Near-black canvas, warm ink — night." },
  { room: "elvish", name: "Solar", hint: "Green twilight, brass ink — dusk." },
];
const INSCRIPTION = elvishInscriptions.elenSila;

/** The three rooms as doorways, and the Solar's colophon. */
export default function SettingsAppearancePaneBody() {
  // the room is the document's (the server paints it from the nx-theme cookie)
  const [room, setRoom] = useState<AppTheme | null>(null);
  const name = useId();
  useEffect(
    () => setRoom(parseRoom(document.documentElement.dataset.theme)),
    [],
  );
  usePaneReturnReady(room !== null);

  // Appearance belongs to this browser; its cookie supplies the next first paint.
  function choose(next: AppTheme) {
    setRoom(next);
    document.documentElement.dataset.theme = next;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", ROOM_CHROME[next]);
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax${window.location.protocol === "https:" ? "; secure" : ""}`;
  }

  if (room === null) return null;
  return (
    <PaneSurface>
      <PaneSection title="Theme">
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Choose how Nexus looks.</legend>
          {DOORWAYS.map((doorway) => (
            <label key={doorway.room} className={styles.doorway}>
              <Plate room={doorway.room} />
              <span className={styles.caption}>
                <input
                  type="radio"
                  name={name}
                  value={doorway.room}
                  checked={room === doorway.room}
                  onChange={() => void choose(doorway.room)}
                />
                <span className={styles.name}>{doorway.name}</span>
              </span>
              <span className={styles.hint}>{doorway.hint}</span>
              {/* hidden from the radio's name ("Solar" and its hint); the
                  colophon carries the Latin as readable text */}
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

// A miniature of one room painted by the real theme mechanism: the plate carries
// that room's data-theme, so every token repaints and this file holds no colour.
function Plate({ room }: { room: AppTheme }) {
  return (
    <span className={styles.plate} data-theme={room} aria-hidden="true">
      {room === "elvish" ? <span className={styles.lamp} /> : null}
      <span className={`${styles.line} ${styles.lineFirst}`} />
      <span className={`${styles.line} ${styles.lineSecond}`} />
      <span className={`${styles.line} ${styles.lineThird}`} />
      <span className={styles.accentLine} />
      {room === "elvish" ? <Inscription className={styles.plaque} /> : null}
    </span>
  );
}

// Baked outlines, never a font; the English beside it carries the meaning.
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
