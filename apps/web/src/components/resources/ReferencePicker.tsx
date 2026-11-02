"use client";
/** Local authored candidates remain selectable beside unavailable remote results. What the list
 * region says stands outside the listbox, so no option carries it. */
import ExcerptDisclosure from "./ExcerptDisclosure";
import ResourceBody from "./ResourceBody";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { targetKey } from "@/lib/resourceGraph/useLinkTargets";
import type { ReferenceInput } from "@/lib/resourceGraph/useReferenceInput";
import collection from "@/components/ui/Collection.module.css";
export default function ReferencePicker({ input, onReviewPosition, returnFocus }: { input: ReferenceInput; onReviewPosition(): void; returnFocus: () => HTMLElement | null }) {
  const { state, search, bindings } = input;
  if (!state) return null;
  return <div className={collection.surface}>
    {search.minimum ? <Fact line={{ fact: "type 2 or more characters." }} />
      : search.items.length ? null
      : search.loading ? <Ruling />
      : !search.error && !search.localError ? <Fact line={{ fact: "no matches." }} /> : null}
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
    {search.error ? <Failed error={search.error} noun="library matches" retry={{ run: search.retry, busy: search.list.running !== null }} /> : null}
    <AuthoredReadFailure error={search.localError} occurrence={search.localOccurrence} pending={search.localPending} retry={search.retryLocal} title="couldn’t search notes on this device."/>
    {!search.localComplete ? <Button aria-busy={search.localPending} onClick={search.moreLocal}>show more notes</Button> : null}
    {state.message ? <Fact line={{ fact: state.message, reason: "your search is kept." }}
      verbs={[{ label: "use new destination", commandKey: "Reference.reviewDestination", run: onReviewPosition }]} /> : null}
  </div>;
}
