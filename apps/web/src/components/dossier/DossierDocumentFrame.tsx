"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DOSSIER_DOCUMENT_RUNTIME } from "@/components/dossier/dossierDocumentRuntime";
import {
  hasExactKeys,
  isRecord,
} from "@/lib/validation";
import styles from "./DossierDocumentFrame.module.css";

/**
 * The sealed Machine Hand contract for opaque-origin learning documents: a
 * pre-authored stylesheet per theme, selected only by the closed Nexus theme.
 */
type DossierDocumentTheme = "light" | "dark";

const DOSSIER_DOCUMENT_STYLES: Record<DossierDocumentTheme, string> = {
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

const FRAME_CSP = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The sealed document knows only day and night; the Solar is a dark room.
function currentTheme(): DossierDocumentTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useNexusDocumentTheme(): DossierDocumentTheme {
  const [theme, setTheme] = useState<DossierDocumentTheme>(currentTheme);
  useEffect(() => {
    const update = () => setTheme(currentTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    update();
    return () => observer.disconnect();
  }, []);
  return theme;
}

function buildDossierFrameDocument(input: {
  title: string;
  contentHtml: string;
  theme: DossierDocumentTheme;
  nonce: string;
  channel: string;
}): string {
  const csp = FRAME_CSP(input.nonce);
  const css = DOSSIER_DOCUMENT_STYLES[input.theme];
  return `<!doctype html><html lang="en" class="theme-${input.theme}" data-nexus-channel="${escapeHtmlAttribute(input.channel)}"><head><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}"><title>${escapeHtmlText(input.title)}</title><style nonce="${input.nonce}">${css}</style><script nonce="${input.nonce}">${DOSSIER_DOCUMENT_RUNTIME}</script></head><body>${input.contentHtml}</body></html>`;
}

interface CitationMessage {
  readonly ordinal: number;
  readonly disposition: "Follow" | "Fork";
}

/** The frame is another origin: decode its messages strictly. */
function decodeCitation(value: unknown, channel: string): CitationMessage | null {
  if (
    !isRecord(value) ||
    value.channel !== channel ||
    !hasExactKeys(value, ["channel", "disposition", "kind", "ordinal"]) ||
    value.kind !== "Citation" ||
    typeof value.ordinal !== "number" ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal <= 0 ||
    (value.disposition !== "Follow" && value.disposition !== "Fork")
  ) {
    return null;
  }
  return { ordinal: value.ordinal, disposition: value.disposition };
}

export default function DossierDocumentFrame({
  title,
  revisionRef,
  contentHtml,
  onCitation,
}: {
  title: string;
  revisionRef: string;
  contentHtml: string;
  onCitation: (
    ordinal: number,
    disposition: { readonly kind: "Follow" | "Fork" },
  ) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const theme = useNexusDocumentTheme();
  // Every document generation is a new frame with its own nonce and channel.
  const generation = useMemo(
    () => ({ nonce: randomToken(), channel: randomToken() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: these name the document generation
    [contentHtml, revisionRef, theme, title],
  );
  const srcDoc = useMemo(
    () =>
      buildDossierFrameDocument({
        title,
        contentHtml,
        theme,
        nonce: generation.nonce,
        channel: generation.channel,
      }),
    [contentHtml, generation, theme, title],
  );
  const onCitationRef = useRef(onCitation);
  onCitationRef.current = onCitation;

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = decodeCitation(event.data, generation.channel);
      if (message) {
        onCitationRef.current(message.ordinal, { kind: message.disposition });
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [generation]);

  return (
    <iframe
      key={generation.channel}
      ref={frameRef}
      className={styles.frame}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={`Learning dossier: ${title}`}
    />
  );
}
