"use client";

// Only opened references read their complete targets, in authored order and at
// the map's publication identity. Source activation/reader.inspect holds the
// departure; this disclosure neither adopts a reading place nor writes progress.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import { apiFetch, apiTransportFeedback, isApiError } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { readerLinkTarget } from "@/lib/documentReader/text/linkTarget";
import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetAnchor, activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import resourceStyles from "@/components/resources/ResourceOutline.module.css";
import styles from "./EvidencePane.module.css";

export default function SourceNote({ reference, mediaId, identity, openRequest, reader, onContentChanged }: {
  readonly reference: Schema<"ReaderEvidenceSourceReferenceOut">;
  readonly mediaId: string;
  readonly identity: string;
  readonly openRequest: { readonly id: string } | null;
  readonly reader: Reader;
  readonly onContentChanged: () => void;
}) {
  const [open, setOpen] = useState(openRequest !== null);
  const button = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  const label = reference.item.preview.source?.location_label;
  return <>
    <Button ref={button} variant="ghost" size="sm" aria-expanded={open} aria-controls={open ? id : undefined}
      data-resource-primary onClick={() => {
        if (open && details.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true });
        setOpen(!open);
      }}>source text{label ? ` · ${label}` : ""}</Button>
    {open ? <div ref={details} id={id} className={styles.sourceTargets}>
      <SourceNoteDetail referenceRef={reference.item.ref} mediaId={mediaId} identity={identity} reader={reader} onContentChanged={onContentChanged} />
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
    return <div key={target.item.ref} className={styles.sourceTarget}>
      <div onClick={(event) => {
        const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
        if (!anchor) return;
        const target = anchor.getAttribute("href") === "#" ? readerLinkTarget(anchor) : null;
        if (target) {
          event.preventDefault();
          void reader.inspect({ target });
        } else activateTargetAnchor({ event, runtime, anchor });
      }}>{body}</div>
      <div className={styles.sourceActions}>
        {href ? <a className={resourceStyles.source} href={href} data-workspace-rich-target="true"
          onClick={(event) => activateTargetLink({ event, runtime, href, labelHint: target.item.label })}>view in source</a>
          : <span className={resourceStyles.quiet}>source location unavailable</span>}
      </div>
    </div>;
  })}</>;
}
