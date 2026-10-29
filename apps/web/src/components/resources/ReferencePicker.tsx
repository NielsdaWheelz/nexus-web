"use client";
/** Local authored candidates remain selectable beside unavailable remote results. */
import ExcerptDisclosure from "./ExcerptDisclosure";
import ResourceBody from "./ResourceBody";
import { FeedbackNotice, FeedbackStatus, FeedbackFailure, FeedbackBusy, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import collection from "@/components/ui/Collection.module.css";
export default function ReferencePicker({ input, onReviewPosition, returnFocus }: { input: ReferenceInput; onReviewPosition(): void; returnFocus: () => HTMLElement | null }) {
  const { state, search, bindings } = input;
  const remoteOccurrence = useFeedbackOccurrence(search.error !== null, search.list.requestedKey);
  if (!state) return null;
  return <div className={collection.surface}>
    {search.minimum ? <FeedbackStatus content={{ tone: "Neutral", title: "type at least 2 characters" }} announcement="Polite" /> : null}
    <FeedbackBusy subject={JSON.stringify([state.context.source_ref, state.row_id, state.raw])} pending={search.loading}/>
    {!search.minimum && !search.loading && !search.items.length && !search.error && !search.localError ? <p>no matching resources</p> : null}
    <div {...bindings.listProps} ref={bindings.listRef} aria-busy={search.loading} className={collection.compactViewport}>
      {search.items.map(target => {
        const key = targetKey(target), scheme = parseResourceRef(target.item.ref)!.scheme;
        const props = bindings.optionProps(key);
        return <div key={key} {...props} className={collection.row} aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-detail`}>
          <div className={collection.content}><div id={`${props.id}-label`}><ResourceBody body={target.item.preview.body} /></div><span id={`${props.id}-detail`} className={collection.detail}>{resourceTypeLabel(scheme)}{target.existing_link_id ? " · already linked" : ""}</span></div>
        </div>;
      })}
    </div>
    <ExcerptDisclosure item={search.items.find(target => targetKey(target) === input.selected)?.item ?? null} returnFocus={returnFocus} />
    {search.error ? <FeedbackFailure scope="Local" occurrence={remoteOccurrence} content={{ tone: "Warning", title: "remote resources aren’t available", requestId: search.error.requestId }} announcement="Polite" actions={[{ label: "retry remote search", onClick: search.retry, busy: search.list.running !== null }]} /> : null}
    <AuthoredReadFailure error={search.localError} occurrence={search.localOccurrence} pending={search.localPending} retry={search.retryLocal} title="couldn’t search notes on this device"/>
    {!search.localComplete ? <Button reserveIcon aria-busy={search.localPending} onClick={search.moreLocal}>show more notes</Button> : null}
    {state.message ? <FeedbackNotice content={{ tone: "Warning", title: state.message }} announcement="Polite" actions={[{ label: "review this destination", onClick: onReviewPosition }]} /> : null}
  </div>;
}
