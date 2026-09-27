"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import type { ReaderEvidenceSourceContent } from "@/lib/reader/documentMap";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import styles from "./EvidencePaneSurface.module.css";

interface SourceNoteContentProps {
  content: ReaderEvidenceSourceContent;
  label: string;
  expansionRequest: number | null;
  onBrowse: () => void;
  onOpenLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
}

function isSourceReaderLink(href: string): boolean {
  const destination = new URL(href, window.location.href);
  return destination.origin === window.location.origin &&
    /^\/media\/[^/]+$/.test(destination.pathname) && destination.hash.startsWith("#text-");
}

/** The full source body owns its DOM. A long-note preview is separately measured
 * plain text, so clipped source links never enter keyboard or screen-reader flow. */
export default function SourceNoteContent({
  content,
  label,
  expansionRequest,
  onBrowse,
  onOpenLink,
}: SourceNoteContentProps) {
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fullRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLParagraphElement | null>(null);
  const measureRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(expansionRequest !== null);
  const [prepared, setPrepared] = useState<{
    source: string;
    html: string;
    imageLabel: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<{ long: boolean; text: string } | null>(null);
  const sourceHtml = content.kind === "Html" ? content.html_sanitized : null;
  const sourceText = content.kind === "Unavailable" ? "" : content.text;

  useEffect(() => {
    if (expansionRequest !== null) setExpanded(true);
  }, [expansionRequest]);

  useLayoutEffect(() => {
    if (sourceHtml === null) {
      setPrepared(null);
      return;
    }
    // This projects already-sanitized markup; it does not widen the sanitizer's
    // allowed content. Canonical source hrefs are resolved by the API owner.
    const document = new DOMParser().parseFromString(sourceHtml, "text/html");
    for (const element of document.body.querySelectorAll("*")) {
      const href = element.getAttribute("href");
      if (element instanceof HTMLAnchorElement && href !== null && isSourceReaderLink(href)) {
        // The reader owns canonical source excursions before the workspace's
        // capture-phase generic link handler can navigate this pane.
        element.setAttribute("data-workspace-rich-target", "true");
      }
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name === "id" || attribute.name === "name") {
          element.setAttribute(attribute.name, `${contentId}-${attribute.value}`);
        } else if (attribute.name === "aria-labelledby") {
          element.setAttribute(
            attribute.name,
            attribute.value.split(/\s+/).map((id) => `${contentId}-${id}`).join(" "),
          );
        } else if (
          element.namespaceURI === "http://www.w3.org/2000/svg" &&
          (attribute.name === "href" || attribute.name === "xlink:href") &&
          attribute.value.startsWith("#")
        ) {
          element.setAttributeNS(
            attribute.namespaceURI,
            attribute.name,
            `#${contentId}-${attribute.value.slice(1)}`,
          );
        } else if (["fill", "stroke", "clip-path"].includes(attribute.name)) {
          element.setAttribute(
            attribute.name,
            attribute.value.replace(/url\(\s*#([-\w:.]+)\s*\)/g, `url(#${contentId}-$1)`),
          );
        } else if (attribute.name.startsWith("data-reader-apparatus-")) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    const image = document.body.querySelector("img");
    const html = document.body.innerHTML;
    // A return link is not a useful preview of an otherwise image-only note.
    for (const anchor of document.body.querySelectorAll("a")) anchor.remove();
    setPrepared({
      source: sourceHtml,
      html,
      imageLabel: image && !document.body.textContent?.trim()
        ? image.getAttribute("alt")?.trim() || label
        : null,
    });
  }, [contentId, label, sourceHtml]);

  const htmlReady = sourceHtml === null || prepared?.source === sourceHtml;
  useLayoutEffect(() => {
    const root = rootRef.current;
    const full = fullRef.current;
    const measure = measureRef.current;
    if (!root || !full || !measure || !htmlReady) return;
    let waitingForSelection = false;
    const measurePreview = () => {
      if (root.clientWidth === 0) return;
      const selection = document.getSelection();
      const selectedNode = selection !== null && !selection.isCollapsed && selection.rangeCount > 0
        ? selection.getRangeAt(0).commonAncestorContainer : null;
      if (selectedNode && previewRef.current?.contains(selectedNode)) {
        // Reflow may temporarily lengthen this opening. Do not replace text the
        // reader is selecting; restore the preview budget after selection ends.
        waitingForSelection = true;
        return;
      }
      waitingForSelection = false;
      const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
        // justify-defect: the owned source-content stylesheet defines line-height.
        throw new Error("Source note content has no measurable line height.");
      }
      const budget = lineHeight * 6;
      const long = full.getBoundingClientRect().height > budget;
      if (
        long &&
        (full.contains(document.activeElement) ||
          (selectedNode !== null && full.contains(selectedNode)))
      ) {
        setExpanded(true);
      }
      let text = prepared?.imageLabel || sourceText.trim() || label;
      if (long) {
        const characters = Array.from(text);
        let low = 0;
        let high = characters.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          measure.textContent = characters.slice(0, middle).join("") + (middle < characters.length ? "…" : "");
          if (measure.getBoundingClientRect().height <= budget) low = middle;
          else high = middle - 1;
        }
        text = characters.slice(0, low).join("").trimEnd();
        if (low < characters.length) text += "…";
      }
      setPreview((previous) =>
        previous?.long === long && previous.text === text ? previous : { long, text },
      );
    };
    measurePreview();
    const observer = new ResizeObserver(measurePreview);
    observer.observe(root);
    observer.observe(full);
    const afterSelection = () => { if (waitingForSelection) measurePreview(); };
    document.addEventListener("selectionchange", afterSelection);
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", afterSelection);
    };
  }, [htmlReady, label, prepared, sourceText]);

  if (content.kind === "Unavailable") {
    return <p className={styles.sourcePreview}>Note text unavailable.</p>;
  }
  const hidden = !htmlReady || preview === null || (preview.long && !expanded);
  return (
    <div ref={rootRef} className={styles.sourceContent}>
      <div
        ref={fullRef}
        id={contentId}
        className={styles.sourceFull}
        data-measuring={hidden ? "true" : undefined}
        aria-hidden={hidden || undefined}
        inert={hidden}
        onPointerDownCapture={onBrowse}
        onFocusCapture={onBrowse}
        onClick={(event) => {
          if (
            event.defaultPrevented || event.button !== 0 ||
            event.metaKey || event.ctrlKey || event.altKey
          ) return;
          const target = event.target;
          if (!(target instanceof Element)) return;
          const anchor = target.closest<HTMLAnchorElement>("a[href]");
          if (
            !anchor || !event.currentTarget.contains(anchor) ||
            (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")
          ) return;
          const href = anchor.getAttribute("href");
          if (href === null) return;
          if (!isSourceReaderLink(href)) return;
          event.preventDefault();
          onBrowse();
          onOpenLink(href, workspaceTargetClickIntent(event).disposition);
        }}
      >
        {content.kind === "Html" ? (
          htmlReady && prepared ? <HtmlRenderer htmlSanitized={prepared.html} /> : null
        ) : (
          <p className={styles.sourcePreview}>{content.text}</p>
        )}
      </div>
      {hidden && preview ? <p ref={previewRef} className={styles.sourcePreview}>{preview.text}</p> : null}
      <p ref={measureRef} className={styles.sourcePreviewMeasure} aria-hidden="true" inert />
      {preview?.long ? (
        <button
          type="button"
          className={styles.disclosureButton}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => {
            onBrowse();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "Collapse note" : "Read full note"}
        </button>
      ) : null}
    </div>
  );
}
