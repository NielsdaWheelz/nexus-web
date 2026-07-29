"use client";

import type { HTMLAttributes } from "react";
import styles from "./MachineText.module.css";

export interface MachineOrigin {
  /**
   * Honest origin label for the small-caps signature (e.g. "Assistant",
   * "Synapse", "Dossier"). MUST derive from the surface's own provenance
   * (message.role, edge.origin, model attribution) — never a literal invented
   * in the component. Also stamped onto `data-machine-origin` for the gate.
   */
  label: string;
}

/**
 * Signature time travels as a pair — both fields or neither (D-9). A discriminated
 * union so a call site can't construct a bare `timestamp` (which would render an
 * HTML-invalid `<time>` with no `datetime`) at the type level.
 */
export type MachineSignatureTime =
  /** Signed with a time: ALREADY-FORMATTED display string ("06:14") + the ISO instant backing `<time datetime>`. */
  | { timestamp: string; timestampIso: string }
  /** No honest time — no `<time>` is rendered. */
  | { timestamp?: null; timestampIso?: null };

export type MachineTextProps = HTMLAttributes<HTMLElement> & {
  origin: MachineOrigin;
  variant?: "block" | "inline";
  showSignature?: boolean;
  as?: "div" | "section" | "span";
} & MachineSignatureTime;

export type MachineDocumentTheme = "light" | "dark";

const MACHINE_DOCUMENT_STYLES: Record<MachineDocumentTheme, string> = {
  light: `
:root{color-scheme:light;background:#fff;color:#3c4a57;font-family:"SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:16px;line-height:1.72}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{background:#fff;color:#3c4a57}
article{width:min(100%,72ch);margin:0 auto;padding:clamp(1.25rem,4vw,4rem) clamp(1rem,4vw,3.5rem) 5rem}
header,section{min-width:0}
section+section{margin-top:clamp(2.5rem,7vw,4.5rem);padding-top:clamp(1.5rem,4vw,2.5rem);border-top:1px solid #e8e8e3}
h2,h3,h4{margin:0 0 .8em;color:#1a1a1c;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.18;letter-spacing:-.018em;text-wrap:balance}
h2{font-size:clamp(1.55rem,5vw,2.15rem)}
h3{margin-top:2em;font-size:clamp(1.18rem,3.5vw,1.45rem)}
h4{margin-top:1.75em;font-size:1rem;letter-spacing:0}
p,ol,ul,dl,blockquote,pre,figure,table{margin:0 0 1.25rem}
p{max-width:68ch}
ol,ul{padding-inline-start:1.5rem}
li+li{margin-top:.48rem}
dt{color:#1a1a1c;font-weight:700}
dd{margin:.35rem 0 1rem 1rem}
strong{color:#1a1a1c}
em{font-style:italic}
blockquote{padding:.15rem 0 .15rem 1.15rem;border-inline-start:3px solid #b49a73;color:#525258}
pre,code{font-family:inherit}
code{padding:.08em .28em;border-radius:3px;background:#f4f4f0;color:#2f3b46;font-size:.92em}
pre{max-width:100%;overflow:auto;padding:1rem;border:1px solid #d4d4cf;border-radius:6px;background:#f4f4f0;line-height:1.55}
pre code{padding:0;background:transparent}
figure{margin-inline:0}
figcaption{margin-top:.65rem;color:#525258;font-size:.82rem}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:.88rem}
th,td{padding:.65rem .8rem;border:1px solid #d4d4cf;text-align:start;vertical-align:top}
th{background:#f4f4f0;color:#1a1a1c;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:650}
.dossier-lede{color:#2f3b46;font-size:1.08rem;line-height:1.68}
.dossier-definition,.dossier-example,.dossier-warning,.dossier-diagram{margin:1.5rem 0;padding:.9rem 0 .9rem 1rem;border-inline-start:3px solid #b49a73}
.dossier-example{border-color:#567a61}
.dossier-warning{border-color:#9a623d}
.dossier-diagram{overflow-x:auto;border-color:#62798f;white-space:pre-wrap}
.dossier-steps{padding-inline-start:1.65rem}
.dossier-muted{color:#525258}
.dossier-citation{display:inline-flex;align-items:center;justify-content:center;min-width:1.3rem;min-height:1.3rem;margin:0 .08rem;padding:0 .25rem;border:1px solid transparent;border-radius:4px;background:transparent;color:#634a29;font:700 .72rem/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;vertical-align:super;cursor:pointer}
.dossier-citation:hover{background:#f4f4f0;border-color:#d4d4cf}
.dossier-citation:focus-visible{outline:2px solid #4a371d;outline-offset:2px}
::selection{background:#e6d6bd;color:#1a1a1c}
@media (max-width:34rem){:root{font-size:15px}article{padding:1.25rem 1rem 3rem}section+section{margin-top:2.25rem}th,td{padding:.5rem .6rem}}
@media print{:root,body{background:#fff;color:#111;font-size:11pt}article{width:100%;max-width:none;padding:0}section+section{break-before:auto;border-color:#bbb}h2,h3,h4,strong,dt{color:#111}pre,table,figure,.dossier-definition,.dossier-example,.dossier-warning,.dossier-diagram{break-inside:avoid}.dossier-citation{color:#111;border:0}}
`,
  dark: `
:root{color-scheme:dark;background:#161618;color:#c4ccd6;font-family:"SFMono-Regular",Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:16px;line-height:1.72}
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{background:#161618;color:#c4ccd6}
article{width:min(100%,72ch);margin:0 auto;padding:clamp(1.25rem,4vw,4rem) clamp(1rem,4vw,3.5rem) 5rem}
header,section{min-width:0}
section+section{margin-top:clamp(2.5rem,7vw,4.5rem);padding-top:clamp(1.5rem,4vw,2.5rem);border-top:1px solid #2c2c30}
h2,h3,h4{margin:0 0 .8em;color:#ededef;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.18;letter-spacing:-.018em;text-wrap:balance}
h2{font-size:clamp(1.55rem,5vw,2.15rem)}
h3{margin-top:2em;font-size:clamp(1.18rem,3.5vw,1.45rem)}
h4{margin-top:1.75em;font-size:1rem;letter-spacing:0}
p,ol,ul,dl,blockquote,pre,figure,table{margin:0 0 1.25rem}
p{max-width:68ch}
ol,ul{padding-inline-start:1.5rem}
li+li{margin-top:.48rem}
dt{color:#ededef;font-weight:700}
dd{margin:.35rem 0 1rem 1rem}
strong{color:#ededef}
em{font-style:italic}
blockquote{padding:.15rem 0 .15rem 1.15rem;border-inline-start:3px solid #8f7958;color:#a3a3a8}
pre,code{font-family:inherit}
code{padding:.08em .28em;border-radius:3px;background:#23232a;color:#d7dce3;font-size:.92em}
pre{max-width:100%;overflow:auto;padding:1rem;border:1px solid #44444a;border-radius:6px;background:#1c1c1f;line-height:1.55}
pre code{padding:0;background:transparent}
figure{margin-inline:0}
figcaption{margin-top:.65rem;color:#a3a3a8;font-size:.82rem}
table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;font-size:.88rem}
th,td{padding:.65rem .8rem;border:1px solid #44444a;text-align:start;vertical-align:top}
th{background:#23232a;color:#ededef;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:650}
.dossier-lede{color:#d7dce3;font-size:1.08rem;line-height:1.68}
.dossier-definition,.dossier-example,.dossier-warning,.dossier-diagram{margin:1.5rem 0;padding:.9rem 0 .9rem 1rem;border-inline-start:3px solid #8f7958}
.dossier-example{border-color:#6e9878}
.dossier-warning{border-color:#b8784f}
.dossier-diagram{overflow-x:auto;border-color:#7893aa;white-space:pre-wrap}
.dossier-steps{padding-inline-start:1.65rem}
.dossier-muted{color:#a3a3a8}
.dossier-citation{display:inline-flex;align-items:center;justify-content:center;min-width:1.3rem;min-height:1.3rem;margin:0 .08rem;padding:0 .25rem;border:1px solid transparent;border-radius:4px;background:transparent;color:#d4b687;font:700 .72rem/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;vertical-align:super;cursor:pointer}
.dossier-citation:hover{background:#23232a;border-color:#44444a}
.dossier-citation:focus-visible{outline:2px solid #d4b687;outline-offset:2px}
::selection{background:#5b4930;color:#fff}
@media (max-width:34rem){:root{font-size:15px}article{padding:1.25rem 1rem 3rem}section+section{margin-top:2.25rem}th,td{padding:.5rem .6rem}}
@media print{:root,body{background:#fff;color:#111;font-size:11pt}article{width:100%;max-width:none;padding:0}section+section{break-before:auto;border-color:#bbb}h2,h3,h4,strong,dt{color:#111}pre,table,figure,.dossier-definition,.dossier-example,.dossier-warning,.dossier-diagram{break-inside:avoid}.dossier-citation{color:#111;border:0}}
`,
};

/**
 * The sealed Machine Hand contract for opaque-origin learning documents.
 * Values are pre-authored and selected only by the closed Nexus theme.
 */
export function machineDocumentStyles(theme: MachineDocumentTheme): string {
  return MACHINE_DOCUMENT_STYLES[theme];
}

/**
 * MachineText — the sole owner of the machine-voice typographic register: the
 * machine face, a cooler ink, the hairline apparatus rail, and the small-caps
 * origin signature. Every machine-voice surface composes it; the machine tokens
 * are referenced ONLY through MachineText.module.css.
 */
export default function MachineText({
  origin,
  timestamp,
  timestampIso,
  variant = "block",
  showSignature = true,
  as,
  className,
  children,
  ...rest
}: MachineTextProps) {
  const isInline = variant === "inline";
  const Tag = as ?? (isInline ? "span" : "div");
  const classes = [styles.machine, isInline ? styles.inline : styles.block, className]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={classes} data-machine-origin={origin.label} {...rest}>
      {!isInline && showSignature ? (
        <MachineSignature
          label={origin.label}
          timestamp={timestamp}
          timestampIso={timestampIso}
        />
      ) : null}
      {children}
    </Tag>
  );
}

function MachineSignature({
  label,
  timestamp,
  timestampIso,
}: {
  label: string;
  timestamp?: string | null;
  timestampIso?: string | null;
}) {
  return (
    <div className={styles.signature}>
      <span className={styles.origin}>{label}</span>
      {timestamp ? (
        <time className={styles.time} dateTime={timestampIso ?? undefined}>
          {`· ${timestamp}`}
        </time>
      ) : null}
    </div>
  );
}
