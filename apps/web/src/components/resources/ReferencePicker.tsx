"use client";

// Presentation only. The editor remains the combobox and keeps keyboard focus.
import ResourceBody from "./ResourceBody";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import {
  parseResourceRef,
  resourceTypeLabel,
} from "@/lib/resourceGraph/resourceRef";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import styles from "./ReferencePicker.module.css";
export default function ReferencePicker({
  input,
  id,
  onReviewPosition,
  returnFocus,
}: {
  input: ReferenceInput;
  id: string;
  onReviewPosition(): void;
  returnFocus: () => HTMLElement | null;
}) {
  const { state, search, selected } = input;
  if (!state) return null;
  return (
    <div className={styles.picker}>
      <div
        id={id}
        role="listbox"
        aria-label={`link from ${state.host.label}`}
        aria-busy={search.loading}
      >
        {search.minimum ? (
          <FeedbackStatus
            content={{ tone: "Neutral", title: "type at least 2 characters" }}
            announcement="Polite"
          />
        ) : null}
        {search.loading ? (
          <FeedbackStatus
            content={{ tone: "Neutral", title: "searching…" }}
            announcement="Polite"
          />
        ) : null}
        {!search.minimum &&
        !search.loading &&
        !search.error &&
        search.items.length === 0 ? (
          <FeedbackStatus
            content={{ tone: "Neutral", title: search.list.complete ? "no matching resources" : "no matching resources found so far" }}
            announcement="Polite"
          />
        ) : null}
        {search.items.map((target) => {
          const key = targetKey(target),
            scheme = parseResourceRef(target.item.ref)!.scheme;
          return (
            <div
              key={key}
              id={`${id}-${key}`}
              role="option"
              aria-selected={key === selected}
              className={styles.option}
              data-active={key === selected || undefined}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                input.accept(target);
              }}
              onPointerMove={(event) => {
                if (event.pointerType !== "touch") input.choose(key);
              }}
            >
              <ResourceBody body={target.item.preview.body} />
              <span className={styles.meta}>
                {resourceTypeLabel(scheme)}
                {target.item.preview.source?.title
                  ? ` · ${target.item.preview.source.title}`
                  : ""}
                {target.existing_link_id ? " · already linked" : ""}
                {scheme === "conversation" ? " · adds chat context" : ""}
              </span>
            </div>
          );
        })}
      </div>
      <span className="sr-only" aria-live="polite">
        {search.items.find((item) => targetKey(item) === selected)?.item
          .label ?? ""}
      </span>
      {search.error ? (
        <FeedbackNotice
          content={{
            tone: "Warning",
            title: "couldn’t search",
            requestId: search.error.requestId,
          }}
          announcement="Polite"
          actions={[{ label: "retry", onClick: search.retry, busy: search.list.running !== null }]}
          returnFocus={returnFocus}
        />
      ) : null}
      {!search.minimum && search.querySettled ? <CollectionExhaustionNotice list={search.list} unit={{ singular: "resource", plural: "resources" }} returnFocus={returnFocus} /> : null}
      {state.message ? <FeedbackNotice content={{ tone: "Warning", title: state.message }} announcement="Polite"
        actions={[{ label: "use this row’s current position", onClick: onReviewPosition }]} /> : null}
    </div>
  );
}
