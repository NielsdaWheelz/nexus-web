// The Solar's Tengwar inscriptions, baked to outline. Direction §5 is the law
// here: no Tengwar webfont ships, ever, and no string the application computed is
// ever rendered in Tengwar. These paths are frozen artwork — consumers draw them
// as `aria-hidden` inline SVG, and the English beside them carries the meaning.
// Deleting every path in this file must cost the app nothing but ornament.
//
// Changing a line means re-running the whole ritual (blueprint §3): compose the
// Latin, transcribe it independently in two engines, diff at the tengwa level,
// set it in a design-machine face, convert to outlines. Never hand-edit a `d`
// string, and never author tengwar from memory.
//
// Import this module directly from the surface that draws it. It must not enter
// a shared barrel: it is data-heavy and only three surfaces need it.

export type ElvishTranscription = {
  readonly engine: string;
  readonly settings: string;
  /** The engine's own output, in the encoding that engine emits. */
  readonly output: string;
  readonly notes?: string;
};

export type ElvishInscription = {
  /** Stable key; also the record key. */
  readonly id: string;
  /** Every surface licensed to draw this inscription (direction §5.2, §5.5, §8.11). */
  readonly surfaces: readonly string[];
  readonly latin: string;
  readonly language: string;
  /** Never mixed within one inscription (direction §5, step 3). */
  readonly mode: string;
  readonly translation: string;
  /** Verbatim output of each engine, kept so the diff can be re-checked. */
  readonly transcriptions: readonly ElvishTranscription[];
  /** What the baked outline was checked against, and how far that check reaches. */
  readonly verifiedAgainst: string;
  readonly transcribedAt: string;
  readonly reviewer: string;
  /** Coordinate space of `paths`. */
  readonly viewBox: string;
  /** One `d` string per word of `latin`, in reading order. */
  readonly paths: readonly string[];
};

export const elvishInscriptions = {
  elenSila: {
    id: "elenSila",
    surfaces: ["colophon", "settings-doorway-plaque", "reader-chapter-opener"],
    latin: "Elen síla lúmenn' omentielvo",
    language: "Quenya",
    mode: "Tengwar, classical Quenya mode — tehtar over the preceding tengwa, long vowels on a long carrier (ára)",
    translation: "A star shines on the hour of our meeting.",
    transcriptions: [
      {
        engine: "Glaemscribe 1.3.1 (BenTalagan/glaemscribe, bundled js/glaemscribe.js, run under Node)",
        settings: "mode quenya-tengwar-classical 0.9.12 with stock option defaults; charset tengwar_ds_annatar 0.2.0 (Dan Smith layout, Tengwar Annatar keymap)",
        output: "`Vſ$5 8~Bj# ſ~Mt$5\" `Nt$4%`VſyY",
        notes: "Charset-independent tengwa sequence from the same run: TELCO+E LAMBE+E NUMEN / SILME ARA+I LAMBE+A / LAMBE ARA+U MALTA+E NUMEN+GEMINATE / TELCO+O MALTA+E ANTO+I TELCO+E LAMBE VALA+O. The same sequence rendered through charset tengwar_telcontar encodes as U+E02E E046 E022 E046 E010 / E024 E02C E044 E022 E040 / E022 E02C E04C E011 E046 E010 E051 / E02E E04A E011 E046 E00C E044 E02E E046 E022 E015 E04A.",
      },
      {
        engine: "Tecendil (tecendil.com), driven headlessly in Chromium on 2026-09-03",
        settings: "Quenya mode, Telcontar font, CSUR private-use output",
        output: "U+E0AE E046 E022 E046 E010 / E024 E02C E044 E022 E040 / E022 E02C E04C E011 E046 E010 E051 / E02E E04A E011 E046 E00C E044 E02E E046 E022 E015 E04A",
        notes: "Tecendil emits U+E0AE, a capital-form short carrier, for the initial vowel because the Latin source is capitalised; lowercasing the input yields U+E02E and matches Glaemscribe exactly. Words are separated by NBSP rather than SPACE.",
      },
    ],
    verifiedAgainst: "Two independent engines, tengwa for tengwa: Glaemscribe 1.3.1 (quenya-tengwar-classical) and Tecendil (Quenya) agree on all sixteen tengwar, both carriers, all eleven tehtar and the gemination bar. The only deltas are presentational — Tecendil’s capital-form short carrier for the capitalised initial vowel, and NBSP for SPACE. Canon check on gross shape: the phrase is Frodo’s greeting (LotR I.3); in the classical mode a word-initial vowel has no preceding tengwa to carry its tehta, so “elen” must open on a short carrier bearing the e-tehta, which is what both engines produce, and the long vowels of “síla” and “lúmenn’” ride a long carrier placed after their consonant. Outlines were set in Tengwar Annatar 1.20 (Johan Winge, 2005, freeware, design-machine only), simplified to 1.16% of an em and checked against the unsimplified outline both numerically and by eye.",
    transcribedAt: "2026-09-03",
    reviewer: "solar-s3-workflow",
    viewBox: "0 0 122.41 13.61",
    paths: [
      "m0 5.46 q0-.2.35-.52.51-.46.99-.46.51 0 .51.97 0 1.6-.04 1.93-.1.65-.59 1.14-.54.52-.54.21 0-.07.1-.21.19-.26.23-.64.02-.34.02-1.77 0-1.25-.73-.68-.3.24-.3.03zm2.56-4.9 q.27 0 .27.27 0 .11-.08.22-.18.28-1.51 1.58-.74.73-.84.73-.11-.03-.13-.13 0-.17 1.33-1.74.79-.93.96-.93zm7.31 4.14 q1.08 0 1.67-.47.22-.12.22.03 0 .3-.65.76-.68.5-1.99.5-.67 0-2.02-.18-.78-.11-.81-.08 l-.38.32 q-1 .91-1.41 1.62-.43.72-.43 1.5 0 1.13.76 1.94.99 1.07 2.6 1.07 2.18 0 3.01-1.68.34-.67.03-1.04-.49-.58.07-.98.57-.41.84.22.08.19.08.42 0 .86-.97 1.99-.39.46-.75.75-1.38 1.14-3 1.14-1.26 0-2.21-.68-1.27-.92-1.27-2.44 0-1.19.93-2.47.6-.8 1.57-1.68.13-.12-1-.12-1.1 0-1.67.46-.22.14-.22-.02 0-.18.33-.5.79-.76 2.24-.76.72 0 2.22.19 1.49.19 2.21.19zm-3.18-1.34 q-.31-.07.01-.34 1.14-1.06 2.05-1.79 1.02-.79 1.02-.21 0 .16-.31.41-1.07.84-2.06 1.51-.61.42-.71.42zm7.48 2.14  0 .34 q.28-.38.8-.78 1.52-1.19 2.4-.27.3.32.46.98 l.26-.28 q1.08-1.1 1.96-1.1.87 0 1.21 1.04.35 1.01-.35 2.13-.77 1.25-1.83 1.25-.71 0-.71-.53 0-.65.66-.65.22 0 .37.16.21.2.42.2.73 0 .73-1.19 0-1.03-.71-1.46-.75-.45-1.46.34-.23.26-.49.88-.95 2.25-2.25 2.25-.75 0-.75-.53 0-.65.66-.65.22 0 .37.16.35.33.8.1.32-.46.32-1.06 0-1.38-1.03-1.61-.58-.09-1.19.42-.53.45-.7 1.74-.08.64-.58 1.13-.54.54-.54.22 0-.07.11-.22.19-.27.21-.63.02-.34.02-1.8 0-1.23-.72-.65-.31.24-.31.03 0-.21.35-.52.52-.46 1-.46.51 0 .51 1.02z",
      "m27.99.95 q0-.15.25-.42.49-.54.7-.12.34.7-.89 2.43 l-.62.79 q-1.11 1.38-1.41 2.01-.59 1.26.42 2.08.52.43 1.2.43 1.37 0 1.37-1.22 0-.32-.2-.55-.46-.53-.04-.95.19-.19.44-.19.61 0 .61.97 0 1.1-1.03 2.01-.87.76-1.83.76-1.47 0-1.88-1.35-.08-.25-.08-.5 0-.84.95-2.18.25-.35 1.11-1.43.78-.99 1.01-1.46.31-.66-.02-1.02-.06-.06-.06-.09zm2.74 4.52 q0-.2.34-.52 1.03-.95 1.4-.23.11.24.11 1.48 0 3.73-.4 5.34-.33 1.32-1.11 1.92-.35.27-.35.06 0-.1.26-.44.12-.14.14-.2.59-1.11.64-5.39.02-1.71-.09-2-.16-.45-.64-.06-.26.2-.3.04zm.53-3.12 q0-.06.36-.41.26-.25.3-.25.07 0 .43.37.23.24.23.29 0 .06-.33.39-.26.27-.33.27-.07 0-.43-.38-.23-.24-.23-.28zm9.37 2.35 q1.09 0 1.67-.47.22-.12.22.03 0 .3-.64.76-.68.5-1.99.5-.68 0-2.02-.18-.78-.11-.81-.08 l-.38.32 q-1.01.91-1.42 1.62-.42.72-.42 1.5 0 1.13.76 1.94.98 1.07 2.59 1.07 2.18 0 3.02-1.68.34-.67.03-1.04-.5-.58.07-.98.57-.41.84.22.08.19.08.42 0 .86-.97 1.99-.39.46-.75.75-1.38 1.14-3.01 1.14-1.25 0-2.2-.68-1.28-.92-1.28-2.44 0-1.19.94-2.47.59-.8 1.57-1.68.12-.12-1.01-.12-1.09 0-1.67.46-.22.14-.22-.02 0-.18.34-.5.79-.76 2.24-.76.72 0 2.22.19 1.48.19 2.2.19zm-2.99-3.63 q0-.06.36-.41.25-.24.3-.24.06 0 .42.35.24.25.24.3 0 .07-.36.41-.25.25-.3.25-.07 0-.43-.37-.23-.24-.23-.29zm-.9 1.28 q0-.07.36-.41.25-.25.31-.25.06 0 .41.36.25.25.25.3 0 .08-.4.44-.23.22-.26.22-.07 0-.42-.36-.25-.25-.25-.3zm1.79 0 q0-.08.37-.43.24-.23.29-.23.06 0 .41.35.25.26.25.31 0 .08-.4.45-.22.21-.26.21-.05 0-.4-.35-.26-.26-.26-.31z",
      "m52.83 4.7 q1.08 0 1.67-.47.22-.12.22.03 0 .3-.64.76-.69.5-2 .5-.67 0-2.02-.18-.78-.11-.81-.08 l-.37.32 q-1.01.91-1.42 1.62-.42.72-.42 1.5 0 1.13.75 1.94.99 1.07 2.6 1.07 2.18 0 3.02-1.68.34-.67.03-1.04-.5-.58.07-.98.56-.41.84.22.07.19.07.42 0 .86-.96 1.99-.39.46-.75.75-1.38 1.14-3.01 1.14-1.26 0-2.2-.68-1.28-.92-1.28-2.44 0-1.19.94-2.47.59-.8 1.57-1.68.12-.12-1.01-.12-1.09 0-1.67.46-.22.14-.22-.02 0-.18.34-.5.78-.76 2.24-.76.72 0 2.22.19 1.48.19 2.2.19zm2.62.77 q0-.2.34-.52 1.03-.95 1.4-.23.11.24.11 1.48 0 3.73-.4 5.34-.33 1.32-1.1 1.92-.36.27-.36.06 0-.1.26-.44.12-.14.14-.2.59-1.11.64-5.39.02-1.71-.08-2-.17-.45-.65-.06-.25.2-.3.04zm1.19-4.47 q0-.14.24-.42.48-.56 1.08-.56.79 0 .79.79 0 .78-1.05 1.54-1.76 1.27-1.79.88 0-.1.8-.67 1.93-1.36 1-1.75-.4-.16-.8.15-.27.21-.27.04zm9.36 7.72 -.23 0-2.91-.04-.22 0 q-1.75 0-3.01.1-.78.06-.49-.27.2-.21.23-.63.02-.34.02-1.8 0-1.23-.72-.65-.31.24-.31.03 0-.21.35-.52.52-.46 1-.46.5 0 .5 1.36.29-.38.81-.78 1.51-1.18 2.39-.27.38.4.48 1 1.68-1.96 2.87-1.19.64.41.64 1.3 0 .97-.91 1.99 l-.09.11 q1.07-.02 1.38-.26.36-.27.36-.07 0 .42-.79.81-.48.25-1.35.24zm-2.91-1.89 q0-1.4-1.03-1.6-.63-.17-1.28.5-.53.54-.58 1.41-.04.46-.26.92 l2.6-.12 q.55-.09.55-1.11zm.09 1.12 q.34 0 2.22.03 1.18 0 1.18-1.39 0-1.18-.95-1.37-.99-.12-1.58 1.05-.09.17-.32.78-.17.44-.55.9zm-.42-4.59 q-.31-.07.01-.34 1.14-1.06 2.05-1.79 1.02-.79 1.02-.21 0 .16-.31.41-1.07.84-2.06 1.51-.61.42-.71.42zm7.47 2.14  0 .34 q.29-.38.81-.78 1.52-1.19 2.4-.27.3.32.46.98 l.26-.28 q1.08-1.1 1.96-1.1.87 0 1.21 1.04.35 1.01-.35 2.13-.77 1.25-1.83 1.25-.71 0-.71-.53 0-.65.66-.65.22 0 .37.16.21.2.42.2.73 0 .73-1.19 0-1.03-.71-1.46-.75-.45-1.46.34-.23.26-.49.88-.95 2.25-2.25 2.25-.75 0-.75-.53 0-.65.66-.65.22 0 .37.16.35.33.8.1.32-.46.32-1.06 0-1.38-1.03-1.61-.58-.09-1.19.42-.53.45-.7 1.74-.08.64-.58 1.13-.54.54-.54.22 0-.07.1-.22.2-.27.22-.63.02-.34.02-1.8 0-1.23-.72-.65-.31.24-.31.03 0-.21.35-.52.52-.46 1-.46.5 0 .5 1.02zm-.93 4.31 q0-.18.31-.45.21-.17.31-.17.86.14 1.09.15.22.01 2.4.01 2.23 0 2.62-.03.29-.02.7-.1.46-.09.01.39-.18.2-.36.26-.57.19-2.57.18 l-.97 0 q-2.26 0-2.68-.04-.83-.07-.86-.2z",
      "m81.09 5.46 q0-.2.35-.52.51-.46.99-.46.51 0 .51.97 0 1.6-.04 1.93-.1.65-.6 1.14-.53.52-.53.21 0-.07.1-.21.19-.26.22-.64.03-.34.03-1.77 0-1.25-.73-.68-.3.24-.3.03zm.44-2.12 q-.09 0-.1-.11 0-.16.76-1.29 1.23-1.83 2.1-1.83.82 0 .82.77 0 .52-.47.99-.62.61-.62.28 0-.06.13-.21.54-.67-.01-1.02-.51-.32-1.95 1.67-.55.75-.66.75zm10.07 5.38 -.23 0-2.91-.04-.22 0 q-1.75 0-3.01.1-.78.06-.49-.27.2-.21.23-.63.03-.34.03-1.8 0-1.23-.73-.65-.31.24-.31.03 0-.21.35-.52.53-.46 1-.46.51 0 .51 1.36.28-.38.8-.78 1.51-1.18 2.39-.27.38.4.48 1 1.68-1.96 2.87-1.19.64.41.64 1.3 0 .97-.91 1.99 l-.09.11 q1.07-.02 1.38-.26.37-.27.37-.07 0 .42-.8.81-.48.25-1.35.24zm-2.91-1.89 q0-1.4-1.03-1.6-.63-.17-1.28.5-.53.54-.58 1.41-.03.46-.26.92 l2.6-.12 q.55-.09.55-1.11zm.09 1.12 q.34 0 2.22.03 1.18 0 1.18-1.39 0-1.18-.95-1.37-.99-.12-1.58 1.05-.08.17-.32.78-.17.44-.55.9zm-.42-4.59 q-.31-.07.01-.34 1.14-1.06 2.05-1.79 1.02-.79 1.02-.21 0 .16-.31.41-1.07.84-2.06 1.51-.61.42-.71.42zm5.85 5.45 q-.2 0 .01-.3.18-.25.22-.63.03-.3.03-2.19 0-2.21.19-3.28.26-1.45 1.1-2.18.43-.38.43-.13 0 .1-.15.3-.31.39-.4.69-.28.86-.35 2.78-.01 1.86-.01 1.97 1.24-1.45 2.36-1.45.62 0 1.04.66.27.42.27.71.01.02.1-.09.2-.27.58-.58 1.7-1.35 2.54-.11.82 1.24-.24 2.73-.77 1.1-1.72 1.1-.72 0-.72-.53 0-.65.66-.65.22 0 .37.16.21.2.42.2.73 0 .73-1.19 0-1.03-.71-1.46-.75-.45-1.46.34-.29.32-.56 1.02-.82 2.11-2.18 2.11-.74 0-.74-.53 0-.65.65-.65.22 0 .37.15.33.34.8.11.78-1.3-.13-2.3-.71-.81-1.74.02-.57.46-.73 1.77-.08.64-.57 1.12-.28.28-.46.31zm3.29-6.46 q0-.07.37-.42.25-.24.29-.24.07 0 .43.37.23.24.23.29 0 .06-.33.39-.26.27-.33.27-.07 0-.43-.38-.23-.24-.23-.28zm5.87 3.11 q0-.2.35-.52.52-.46.99-.46.51 0 .51.97 0 1.6-.04 1.93-.09.65-.59 1.14-.53.52-.53.21 0-.07.1-.21.18-.26.22-.64.02-.34.02-1.77 0-1.25-.73-.68-.3.24-.3.03zm2.57-4.9 q.26 0 .26.27 0 .11-.07.22-.19.28-1.52 1.58-.74.73-.84.73-.11-.03-.13-.13 0-.17 1.33-1.74.8-.93.97-.93zm7.3 4.14 q1.08 0 1.67-.47.22-.12.22.03 0 .3-.64.76-.69.5-1.99.5-.68 0-2.03-.18-.78-.11-.81-.08 l-.37.32 q-1.01.91-1.42 1.62-.42.72-.42 1.5 0 1.13.75 1.94.99 1.07 2.6 1.07 2.18 0 3.02-1.68.34-.67.03-1.04-.5-.58.07-.98.56-.41.84.22.07.19.07.42 0 .86-.96 1.99-.39.46-.75.75-1.38 1.14-3.01 1.14-1.26 0-2.2-.68-1.28-.92-1.28-2.44 0-1.19.94-2.47.59-.8 1.57-1.68.12-.12-1.01-.12-1.09 0-1.67.46-.22.14-.22-.02 0-.18.34-.5.79-.76 2.24-.76.72 0 2.22.19 1.48.19 2.2.19zm7.07 4.02 q-2.86-.06-3.62.06-.52.09-.23-.28.2-.21.23-.62.03-.34.03-1.8 0-1.23-.73-.65-.3.24-.3.03 0-.21.35-.52.52-.46 1-.46.5 0 .5 1.06 0 .38 0 .38.03 0 .13-.13.33-.41.98-.84 1.78-1.18 2.65.02.34.47.34 1.04 0 1.01-.95 1.99 1.05-.02 1.36-.26.36-.28.36-.08 0 .17-.26.43-.59.62-1.84.63zm-1.37-.77 q1.31.03 1.54-.23.34-.4.34-1.02 0-.9-.69-1.3-.63-.37-1.46.03-.95.45-1.12 1.4-.2 1.21-.26 1.21.79-.08 1.65-.09zm-.69-4.61 q-.27 0 .6-1.33 1.23-1.84 2.12-1.84.8 0 .8.79 0 .55-.5 1.01-.59.55-.59.25 0-.06.13-.21.5-.64.01-1.01-.43-.33-1.24.68-1.24 1.66-1.33 1.66z",
    ],
  },
} as const satisfies Record<string, ElvishInscription>;
