"use client";

// Inline results borrow their editor's bindings. Journal admission, captured
// destination review and authored snapshots remain with the reference owner.
import ResourceBody from "./ResourceBody";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import collection from "@/components/ui/Collection.module.css";

export default function ReferencePicker({ input, onReviewPosition, returnFocus }: {
  input: ReferenceInput;
  onReviewPosition(): void;
  returnFocus: () => HTMLElement | null;
}) {
  const { state, search, bindings } = input;
  const emptyTitle = search.list.complete ? "no matching resources" : "no matching resources found so far";
  const readFeedback = useCollectionReadFeedback({
    list: search.list, unit: { singular: "resource", plural: "resources" }, waiting: state !== null && search.querySettled && search.loading,
    outcome: search.items.length > 0 ? "results updated." : emptyTitle, returnFocus,
  });
  return <>
    {state ? <div className={collection.surface}>
      {search.minimum ? <FeedbackStatus content={{ tone: "Neutral", title: "type at least 2 characters" }} announcement="Polite" /> : null}
      {search.loading ? <FeedbackStatus content={{ tone: "Neutral", title: "searching…" }} announcement="Polite" /> : null}
      {!search.minimum && !search.loading && !search.error && search.items.length === 0
        ? <FeedbackStatus content={{ tone: "Neutral", title: emptyTitle }} announcement="None" /> : null}
      <div {...bindings.listProps} ref={bindings.listRef} aria-busy={search.loading} className={collection.compactViewport}>
        {search.items.map(target => {
          const key = targetKey(target), scheme = parseResourceRef(target.item.ref)!.scheme;
          const props = bindings.optionProps(key);
          return <div key={key} {...props} className={collection.row} aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-detail`}>
            <span className={collection.content}>
              <span id={`${props.id}-label`}><ResourceBody body={target.item.preview.body} /></span>
              <span id={`${props.id}-detail`} className={collection.detail}>
                {resourceTypeLabel(scheme)}
                {target.item.preview.source?.title ? ` · ${target.item.preview.source.title}` : ""}
                {target.existing_link_id ? " · already linked" : ""}
                {scheme === "conversation" ? " · adds chat context" : ""}
                {state.message !== null ? " · review destination before linking" : ""}
              </span>
            </span>
          </div>;
        })}
      </div>
      {search.error ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t search", requestId: search.error.requestId }} announcement="Polite"
        actions={[{ label: "retry", onClick: search.retry, busy: search.list.running !== null }]} returnFocus={returnFocus} /> : null}
      {!search.minimum && search.querySettled ? readFeedback.notice : null}
      {state.message ? <FeedbackNotice content={{ tone: "Warning", title: state.message }} announcement="Polite"
        actions={[{ label: "use this row’s current position", onClick: onReviewPosition }]} /> : null}
    </div> : null}
    {readFeedback.announcement}
  </>;
}
