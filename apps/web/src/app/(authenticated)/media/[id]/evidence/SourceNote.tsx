"use client";

// Only opened references mount complete targets, in authored order. Unavailable
// never borrows a preview. Source activation/reader.inspect holds the departure;
// this disclosure neither adopts a reading place nor writes progress.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import type { Schema } from "@/lib/api/wire";
import type { Reader } from "@/lib/documentReader/runtime";
import { readerLinkTarget } from "@/lib/documentReader/text/linkTarget";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetAnchor, activateTargetLink } from "@/lib/panes/targetLinkActivation";
import resourceStyles from "@/components/resources/ResourceOutline.module.css";
import styles from "./EvidencePane.module.css";

export default function SourceNote({ reference, targets, openRequest, reader }: {
  readonly reference: Extract<Schema<"ReaderEvidencePassageGroupOut">["items"][number], { kind: "SourceReference" }>;
  readonly targets: ReadonlyMap<string, Schema<"ReaderEvidenceSourceTargetOut">>;
  readonly openRequest: { readonly id: string } | null;
  readonly reader: Reader;
}) {
  const runtime = usePaneRuntime();
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
      {!reference.target_refs.length ? <FeedbackNotice content={{ tone: "Warning", title: "source text unavailable" }} announcement="None" /> : null}
      {reference.target_refs.map((ref) => {
        const target = targets.get(ref);
        if (!target) throw new Error("Source reference names an absent target");
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
        return <div key={ref} className={styles.sourceTarget}>
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
      })}
    </div> : null}
  </>;
}
