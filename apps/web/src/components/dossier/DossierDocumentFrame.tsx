"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  machineDocumentStyles,
  type MachineDocumentTheme,
} from "@/components/ui/MachineText";
import { isRecord } from "@/lib/validation";
import styles from "./DossierDocumentFrame.module.css";

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

/** Fixed runtime only. No title, article, citation, or request value enters it. */
export const DOSSIER_CITATION_BRIDGE = `(function(){"use strict";var channel=document.documentElement.dataset.nexusChannel;document.addEventListener("click",function(event){var target=event.target instanceof Element?event.target.closest("button.dossier-citation[data-nexus-citation]"):null;if(!target)return;event.preventDefault();var raw=target.getAttribute("data-nexus-citation");if(!raw||!/^[1-9][0-9]*$/.test(raw))return;var ordinal=Number(raw);if(!Number.isSafeInteger(ordinal))return;window.parent.postMessage({channel:channel,kind:"Citation",ordinal:ordinal},"*");});})();`;

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

function currentTheme(): MachineDocumentTheme {
  if (typeof document === "undefined") return "dark";
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function useNexusDocumentTheme(): MachineDocumentTheme {
  const [theme, setTheme] = useState<MachineDocumentTheme>(currentTheme);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)") ?? null;
    const update = () => setTheme(currentTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    media?.addEventListener?.("change", update);
    update();
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, []);
  return theme;
}

export function buildDossierFrameDocument(input: {
  title: string;
  contentHtml: string;
  theme: MachineDocumentTheme;
  nonce: string;
  channel: string;
}): string {
  const csp = FRAME_CSP(input.nonce);
  const css = machineDocumentStyles(input.theme);
  return `<!doctype html><html lang="en" class="theme-${input.theme}" data-nexus-channel="${escapeHtmlAttribute(input.channel)}"><head><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}"><title>${escapeHtmlText(input.title)}</title><style nonce="${input.nonce}">${css}</style><script nonce="${input.nonce}">${DOSSIER_CITATION_BRIDGE}</script></head><body>${input.contentHtml}</body></html>`;
}

function isCitationMessage(
  value: unknown,
  channel: string,
): value is { channel: string; kind: "Citation"; ordinal: number } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 3 &&
    keys[0] === "channel" &&
    keys[1] === "kind" &&
    keys[2] === "ordinal" &&
    value.channel === channel &&
    value.kind === "Citation" &&
    typeof value.ordinal === "number" &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal > 0
  );
}

export default function DossierDocumentFrame({
  title,
  contentHtml,
  onCitation,
}: {
  title: string;
  contentHtml: string;
  onCitation: (ordinal: number) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const credentialsRef = useRef<{ nonce: string; channel: string } | null>(null);
  if (credentialsRef.current === null) {
    credentialsRef.current = {
      nonce: randomToken(),
      channel: randomToken(),
    };
  }
  const { nonce, channel } = credentialsRef.current;
  const theme = useNexusDocumentTheme();
  const srcDoc = useMemo(
    () =>
      buildDossierFrameDocument({
        title,
        contentHtml,
        theme,
        nonce,
        channel,
      }),
    [channel, contentHtml, nonce, theme, title],
  );
  const citationRef = useRef(onCitation);
  citationRef.current = onCitation;

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!isCitationMessage(event.data, channel)) return;
      citationRef.current(event.data.ordinal);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel]);

  return (
    <iframe
      ref={frameRef}
      className={styles.frame}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={`Learning dossier: ${title}`}
    />
  );
}
