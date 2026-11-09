"use client";
/** Local authored candidates remain selectable beside unavailable remote results. What the list
 * region says stands outside the listbox, so no option carries it. */
import ExcerptDisclosure from "./ExcerptDisclosure";
import ResourceBody from "./ResourceBody";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { itemMediaKind, resourceType, resourceTypeName } from "@/lib/resources/type";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import { cx } from "@/lib/ui/cx";
import collection from "@/components/ui/Collection.module.css";
import styles from "./ReferencePicker.module.css";
export default function ReferencePicker({ input, onReviewPosition, returnFocus }: { input: ReferenceInput; onReviewPosition(): void; returnFocus: () => HTMLElement | null }) {
  const { state, search, bindings } = input;
  if (!state) return null;
  return <div className={cx(collection.surface, styles.picker)}>
    {search.minimum ? <Fact line={{ fact: "type 2 or more characters." }} speak />
      : search.items.length ? null
      : search.loading ? <Ruling />
      : !search.error && !search.localError ? <Fact line={{ fact: "no matches." }} /> : null}
    <div {...bindings.listProps} ref={bindings.listRef} aria-busy={search.loading} className={collection.compactViewport}>
      {search.items.map(target => {
        const key = targetKey(target), type = resourceType(parseResourceRef(target.item.ref)!.scheme, itemMediaKind(target.item));
        const props = bindings.optionProps(key);
        return <div key={key} {...props} className={collection.row} aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-detail`}>
          <div className={collection.content}><div id={`${props.id}-label`}><ResourceBody body={target.item.preview.body} /></div><span id={`${props.id}-detail`} className={collection.detail}>{resourceTypeName(type)}{target.existing_link_id ? " · already linked" : ""}</span></div>
        </div>;
      })}
    </div>
    <ExcerptDisclosure item={search.items.find(target => targetKey(target) === input.selected)?.item ?? null} returnFocus={returnFocus} />
    {search.error ? <Failed error={search.error} noun="library matches" retry={{ run: search.retry, busy: search.list.running !== null }} /> : null}
    <AuthoredReadFailure error={search.localError} pending={search.localPending} retry={search.retryLocal} noun="notes"/>
    {!search.localComplete ? <Button aria-busy={search.localPending} onClick={search.moreLocal}>show more notes</Button> : null}
    {state.message ? <Fact line={{ fact: state.message, reason: "your search is kept." }} speak
      verbs={state.context.replacement === null ? [{ label: "use new destination", commandKey: "Reference.reviewDestination", run: onReviewPosition }] : undefined} /> : null}
  </div>;
}
