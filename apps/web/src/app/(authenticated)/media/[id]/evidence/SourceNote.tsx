"use client";

// Only opened references read their complete targets, in authored order and at
// the map's publication identity. Source activation/reader.inspect holds the
// departure; this disclosure neither adopts a reading place nor writes progress.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import { apiFetch, apiTransportFeedback, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { readerLinkTarget } from "@/lib/documentReader/text/linkTarget";
import type { ReaderDestination } from "@/lib/documentReader/location";
import { activateReaderDestination } from "@/lib/documentReader/navigation";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetAnchor, activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import resourceStyles from "@/components/resources/ResourceOutline.module.css";
import type { EvidenceOpenRequest } from "./EvidenceRow";
import styles from "./EvidencePane.module.css";

export default function SourceNote({ reference, mediaId, identity, openRequest, reader, onContentChanged }: {
  readonly reference: Schema<"ReaderEvidenceSourceReferenceOut">;
  readonly mediaId: string;
  readonly identity: string;
  readonly openRequest: EvidenceOpenRequest | null;
  readonly reader: Reader;
  readonly onContentChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || Boolean(openRequest?.isCurrent());
  const button = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const id = useId();
  // The shell commits before the row acknowledges; retirement leaves it open.
  useLayoutEffect(() => { if (openRequest?.isCurrent()) setOpen(true); }, [openRequest]);
  const label = reference.location_label;
  return <>
    <Button ref={button} variant="ghost" size="sm" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
      data-resource-primary onClick={() => {
        if (expanded && details.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true });
        setOpen(!expanded);
      }}>source text{label ? ` · ${label}` : ""}</Button>
    {expanded ? <div ref={details} id={id} className={styles.sourceTargets}>
      <SourceNoteDetail referenceRef={reference.resource_ref} mediaId={mediaId} identity={identity} reader={reader} onContentChanged={onContentChanged} />
    </div> : null}
  </>;
}

function SourceNoteDetail({ referenceRef, mediaId, identity, reader, onContentChanged }: {
  readonly referenceRef: string;
  readonly mediaId: string;
  readonly identity: string;
  readonly reader: Reader;
  readonly onContentChanged: () => void;
}) {
  const runtime = usePaneRuntime();
  const paneActive = usePaneIsActive();
  const item = parseResourceRef(referenceRef);
  if (item?.scheme !== "reader_apparatus_item") throw new Error("Source note needs its apparatus resource");
  const detail = usePaneFreeServerValue({
    key: `reader-apparatus:${mediaId}:${item.id}:${identity}`,
    stale: "",
    load: async (signal) => {
      try {
        const { data } = await apiFetch<ApiJson<"/media/{media_id}/reader-apparatus/{item_id}", "get">>(
          `/api/media/${mediaId}/reader-apparatus/${item.id}?expected_identity=${encodeURIComponent(identity)}`, { signal },
        );
        return data;
      } catch (error) {
        if (!signal.aborted && isApiError(error) && error.code === "E_READER_CONTENT_CHANGED") onContentChanged();
        throw error;
      }
    },
  });
  const announcement = paneActive ? "Polite" : "None";
  if (detail.status === "loading") return <FeedbackStatus content={{ tone: "Neutral", title: "loading source text…" }} announcement={announcement} />;
  if (detail.error?.code === "E_READER_CONTENT_CHANGED") return <FeedbackNotice content={{ tone: "Warning", title: "reader content changed" }} announcement={announcement}
    actions={[{ label: "refresh reader items", onClick: onContentChanged }]} />;
  if (detail.status === "failed") return <FeedbackNotice content={apiTransportFeedback(detail.error, "couldn’t load source text") ?? { tone: "Danger", title: "couldn’t load source text", requestId: detail.error.requestId }} announcement={announcement}
    actions={[{ label: "retry", onClick: detail.refetch, busy: detail.retrying }]} />;
  if (!detail.data.targets.length) return <FeedbackNotice content={{ tone: "Warning", title: "source reference unresolved" }} announcement={announcement} />;
  return <>{detail.data.targets.map((target) => {
    const { content } = target;
    let body: ReactNode;
    switch (content.kind) {
      case "Html": body = <HtmlRenderer htmlSanitized={content.html_sanitized} />; break;
      case "Text": body = <div className={resourceStyles.prose}>{content.text}</div>; break;
      case "Unavailable": body = <FeedbackNotice content={{ tone: "Warning", title: "source text unavailable" }} announcement="None" />; break;
      default: return assertNever(content);
    }
    const { activation } = target.item;
    const href = activation.kind === "route" ? activation.href : null;
    const locator = target.resolution.kind === "Resolved" ? target.resolution.anchor.locator : null;
    const unit = locator && "fragment_id" in locator ? locator.fragment_id : null;
    return <div key={target.item.ref} className={styles.sourceTarget}>
      <SourceContent reader={reader} identity={identity} unit={unit}>{body}</SourceContent>
      <div className={styles.sourceActions}>
        {href ? <a className={resourceStyles.source} href={href} data-workspace-rich-target="true"
          onClick={(event) => activateTargetLink({ event, runtime, target: { href, labelHint: target.item.label } })}
          onKeyDown={(event) => activateTargetLink({ event, runtime, target: { href, labelHint: target.item.label } })}>view in source</a>
          : <span className={resourceStyles.quiet}>source location unavailable</span>}
      </div>
    </div>;
  })}</>;
}

function SourceContent({ reader, identity, unit, children }: { reader: Reader; identity: string; unit: string | null; children: ReactNode }) {
  const runtime = usePaneRuntime();
  const root = useRef<HTMLDivElement>(null);
  const destinations = useRef(new WeakMap<HTMLAnchorElement, ReaderDestination>());
  useLayoutEffect(() => {
    const bound = destinations.current;
    const changed: { anchor: HTMLAnchorElement; href: string; rich: string | null; role: string | null; tabIndex: string | null }[] = [];
    for (const anchor of root.current!.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const target = readerLinkTarget(anchor);
      if (!target) continue;
      const destination = { source_identity: identity, target };
      changed.push({ anchor, href: anchor.getAttribute("href")!, rich: anchor.getAttribute("data-workspace-rich-target"), role: anchor.getAttribute("role"), tabIndex: anchor.getAttribute("tabindex") });
      bound.set(anchor, destination);
      anchor.setAttribute("data-workspace-rich-target", "true");
      const href = reader.navigation?.href(destination);
      if (href) anchor.setAttribute("href", href);
      else if (reader.navigation) {
        anchor.removeAttribute("href");
        anchor.setAttribute("role", "link");
        anchor.setAttribute("tabindex", "0");
      }
    }
    return () => { for (const { anchor, href, rich, role, tabIndex } of changed) {
      anchor.setAttribute("href", href);
      if (rich === null) anchor.removeAttribute("data-workspace-rich-target"); else anchor.setAttribute("data-workspace-rich-target", rich);
      if (role === null) anchor.removeAttribute("role"); else anchor.setAttribute("role", role);
      if (tabIndex === null) anchor.removeAttribute("tabindex"); else anchor.setAttribute("tabindex", tabIndex);
      bound.delete(anchor);
    } };
  }, [children, identity, reader, unit]);
  const activate = (event: TargetActivationEvent & { target: EventTarget | null }) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null;
    if (!anchor) return;
    const destination = destinations.current.get(anchor);
    if (destination) activateReaderDestination(reader, destination, event, undefined, anchor.hasAttribute("href") ? "native" : "activate");
    else activateTargetAnchor({ event, runtime, anchor });
  };
  return <div ref={root} data-reader-unit={unit ?? undefined} onClick={activate} onKeyDown={activate}>{children}</div>;
}
