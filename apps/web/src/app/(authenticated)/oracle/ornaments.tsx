"use client";

import { useState, type ReactNode } from "react";
import styles from "./oracle.module.css";

/** The scoped manuscript palette; the atlas renders under it too. */
export function OracleTheme({ children }: { children: ReactNode }) {
  return (
    <div data-theme="oracle" style={{ display: "contents" }}>
      {children}
    </div>
  );
}

const CORNER = [
  "M 4 22 Q 4 4, 22 4",
  "M 8 28 Q 14 14, 28 8",
  "M 14 14 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0",
];

/** Four gold flourishes at the folio's corners; the double rule is CSS. */
export function BorderFrame() {
  return (
    <div className={styles.borderFrame} aria-hidden="true">
      {[0, 1, 2, 3].map((corner) => (
        <svg key={corner} viewBox="0 0 32 32" focusable="false">
          {CORNER.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      ))}
    </div>
  );
}

export function FleuronBreak() {
  return (
    <div className={styles.fleuron} aria-hidden="true">
      ❦
    </div>
  );
}

/** A marginal note: in the margin on wide folios, behind ⊕ on narrow ones. */
export function Sidenote({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.sidenoteToggle}
        aria-expanded={open}
        aria-label={open ? "Hide marginal note" : "Show marginal note"}
        onClick={() => setOpen((value) => !value)}
      >
        ⊕
      </button>
      <aside className={styles.marginalia} data-open={open}>
        {children}
      </aside>
    </>
  );
}

// Five motifs drawn in stroke around the initial: vine, flame, serpent, star, ouroboros.
const MOTIFS = [
  [
    "M 8 24 Q 18 10, 30 16 T 44 14",
    "M 56 8 Q 70 12, 80 22 T 94 26",
    "M 8 76 Q 18 90, 30 84 T 44 86",
    "M 56 92 Q 70 88, 82 90 T 94 76",
    "M 30 16 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0",
    "M 70 84 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0",
  ],
  [
    "M 50 96 Q 38 84, 44 72 Q 50 60, 56 72 Q 62 84, 50 96 Z",
    "M 18 92 Q 10 80, 20 70 Q 24 78, 18 92 Z",
    "M 82 92 Q 90 80, 80 70 Q 76 78, 82 92 Z",
    "M 50 6 Q 44 14, 50 20 Q 56 14, 50 6 Z",
    "M 28 18 Q 32 26, 26 30",
    "M 72 18 Q 68 26, 74 30",
  ],
  [
    "M 88 50 Q 92 76, 66 86 Q 36 94, 16 78 Q 4 60, 14 42 Q 28 22, 56 22 Q 84 26, 90 42",
    "M 14 60 m -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0",
    "M 8 60 L 14 58",
    "M 8 60 L 14 62",
  ],
  [
    "M 50 4 L 50 20",
    "M 50 80 L 50 96",
    "M 4 50 L 20 50",
    "M 80 50 L 96 50",
    "M 16 16 L 26 26",
    "M 74 16 L 84 26",
    "M 16 84 L 26 74",
    "M 74 84 L 84 74",
    "M 50 50 m -32 0 a 32 32 0 1 0 64 0 a 32 32 0 1 0 -64 0",
  ],
  [
    "M 50 10 A 40 40 0 1 1 28 16",
    "M 28 16 m -3 0 a 3 3 0 1 0 6 0 a 3 3 0 1 0 -6 0",
    "M 22 16 L 28 14",
    "M 22 16 L 28 18",
  ],
];

/** The interpretation's first letter, framed by a motif chosen by hashing the question. */
export function IlluminatedCapital({
  letter,
  seed,
}: {
  letter: string;
  seed: string;
}) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const motif =
    MOTIFS[((hash % MOTIFS.length) + MOTIFS.length) % MOTIFS.length]!;
  return (
    <span className={styles.capital} aria-hidden="true">
      <svg viewBox="0 0 100 100" focusable="false">
        <g className={styles.capitalMotif}>
          {motif.map((d, i) => (
            <path
              key={d}
              d={d}
              pathLength="1"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </g>
        <text
          x="50"
          y="74"
          textAnchor="middle"
          className={styles.capitalLetter}
        >
          {letter}
        </text>
      </svg>
    </span>
  );
}
