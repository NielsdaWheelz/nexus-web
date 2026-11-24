"use client";
/** Local authored candidates remain selectable beside unavailable remote results. What the list
 * region says stands outside the listbox, so no option carries it. */
import ExcerptDisclosure from "./ExcerptDisclosure";
import ResourceBody from "./ResourceBody";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { AuthoredContinuationCursorError } from "@/lib/notes/hooks";
import DiscoveryTail from "@/components/collections/DiscoveryTail";
import { heldDiscoverySlotStyle } from "@/lib/search/discoveryBoundary";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { itemMediaKind, resourceType, resourceTypeName } from "@/lib/resources/type";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import { cx } from "@/lib/ui/cx";
import collection from "@/components/ui/Collection.module.css";
import styles from "./ReferencePicker.module.css";
export default function ReferencePicker({ input, onReviewPosition, returnFocus }: {
  input: Pick<ReferenceInput, "search" | "selected" | "bindings" | "slots" | "holding"> & { state?: ReferenceInput["state"] };
  onReviewPosition?(): void;
  returnFocus: () => HTMLElement | null;
}) {
  const { state, search, bindings, slots, holding } = input;
  const remoteError = holding && search.list.failure?.withdrawn ? null : search.error;
  if (state === null) return null;
  return <div className={cx(collection.surface, styles.picker)}>
    {search.minimum ? <Fact line={{ fact: "type 2 or more characters." }} speak />
      : search.items.length ? null
      : search.loading ? <Ruling />
      : search.complete ? <Fact line={{ fact: "no matches." }} /> : null}
    <div {...bindings.listProps} ref={bindings.listRef} aria-busy={search.loading} className={collection.compactViewport}>
      {slots.map(({ id: key, row: target, height }) => {
        const style = heldDiscoverySlotStyle(height);
        if (target === null) return <div key={key} data-discovery-option={key} style={style} aria-hidden="true" />;
        const type = resourceType(parseResourceRef(target.item.ref)!.scheme, itemMediaKind(target.item));
        const props = bindings.optionProps(key);
        return <div key={key} {...props} className={collection.row} data-discovery-option={key} style={style} aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-detail`}>
          <div className={collection.content}><div id={`${props.id}-label`}><ResourceBody body={target.item.preview.body} /></div><span id={`${props.id}-detail`} className={collection.detail}>{resourceTypeName(type)}{target.existing_link_id ? " · already linked" : ""}</span></div>
        </div>;
      })}
    </div>
    <ExcerptDisclosure item={search.items.find(target => targetKey(target) === input.selected)?.item ?? null} returnFocus={returnFocus} />
    {remoteError?.code === "E_REPEATED_CURSOR" ? <Fact line={{ fact: "couldn’t load more library matches.", reason: "the source repeated its continuation." }} />
      : remoteError ? <Failed error={remoteError} noun="library matches" retry={{ run: search.retry, busy: search.list.running !== null }} /> : null}
    {search.localError instanceof AuthoredContinuationCursorError
      ? <Fact line={{ fact: "couldn’t load more notes.", reason: "the source repeated its continuation." }} />
      : <AuthoredReadFailure error={search.localError} pending={search.localPending} retry={search.retryLocal} noun="notes" />}
    <DiscoveryTail label="continue searching notes" action={search.localCanContinue ? search.moreLocal : null}
      busy={search.localPending} show={search.items.length === 0 || search.localNeedsAction} />
    <DiscoveryTail label="continue searching library matches" action={search.remoteCanContinue ? search.list.more : null}
      busy={search.list.running !== null} show={search.items.length === 0 || search.list.continuationNeedsAction} />
    {state?.message ? <Fact line={{ fact: state.message, reason: "your search is kept." }} speak
      verbs={state.context.replacement === null && onReviewPosition ? [{ label: "use new destination", commandKey: "Reference.reviewDestination", run: onReviewPosition }] : undefined} /> : null}
  </div>;
}
