"use client";
/** Local authored candidates remain selectable beside unavailable remote results. */
import ResourceBody from "./ResourceBody";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import collection from "@/components/ui/Collection.module.css";
export default function ReferencePicker({ input, onReviewPosition }: { input: ReferenceInput; onReviewPosition(): void; returnFocus: () => HTMLElement | null }) {
  const { state, search, bindings } = input;
  if (!state) return null;
  return <div className={collection.surface}>
    {search.minimum ? <FeedbackStatus content={{ tone: "Neutral", title: "type at least 2 characters" }} announcement="Polite" /> : null}
    {search.loading ? <FeedbackStatus content={{ tone: "Neutral", title: "searching…" }} announcement="None" /> : null}
    {!search.minimum && !search.loading && !search.items.length ? <p>no matching resources</p> : null}
    <div {...bindings.listProps} ref={bindings.listRef} aria-busy={search.loading} className={collection.compactViewport}>
      {search.items.map(target => {
        const key = targetKey(target), scheme = parseResourceRef(target.item.ref)!.scheme;
        const props = bindings.optionProps(key);
        return <div key={key} {...props} className={collection.row} aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-detail`}>
          <span className={collection.content}><span id={`${props.id}-label`}><ResourceBody body={target.item.preview.body} /></span><span id={`${props.id}-detail`} className={collection.detail}>{resourceTypeLabel(scheme)}{target.existing_link_id ? " · already linked" : ""}</span></span>
        </div>;
      })}
    </div>
    {search.error ? <FeedbackNotice content={{ tone: "Warning", title: "remote resources aren’t available", requestId: search.error.requestId }} announcement="Polite" actions={[{ label: "retry remote search", onClick: search.retry }]} /> : null}
    {search.localError ? <p role="alert">couldn’t search notes on this device.</p> : null}
    {!search.localComplete ? <Button onClick={search.moreLocal}>show more notes</Button> : null}
    {state.message ? <FeedbackNotice content={{ tone: "Warning", title: state.message }} announcement="Polite" actions={[{ label: "review this destination", onClick: onReviewPosition }]} /> : null}
  </div>;
}
