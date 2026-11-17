"use client";

/** A show's title page: frontispiece, name, byline, standfirst and details, then its lines.
 * The header's h1 stays the one heading; the name is its picture and yields it while shown.
 * A named library's link carries that subscription's removal; All's link is plain. */
import { Fragment, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import Artwork, { remoteArtwork } from "@/components/ui/Artwork";
import { useFocusReturn } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import { Ledger, LedgerLine } from "@/components/ui/Ledger";
import MediaImage from "@/components/ui/MediaImage";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { ContributorCreditList, ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import type { FeedActionFocus, FeedActionSubject } from "@/lib/actions/inlineActions";
import { useFeedActions } from "@/lib/actions/useFeedActions";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { groupContributorCredits, selectMediaAuthors } from "@/lib/contributors/credits";
import type { FeedDetail } from "@/lib/feeds/api";
import { compareLibraryNames } from "@/lib/libraries/views";
import { usePaneTitleYield } from "@/lib/panes/paneChrome";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./FeedTitlePage.module.css";

type Destination = FeedDetail["destinations"][number];

export default function FeedTitlePage({ feed, knownCount, destinations, playbackSettings, editPlayback, subject, removal, lines, detailsOpen, onDetails }: {
  readonly feed: FeedDetail["feed"];
  readonly knownCount: number;
  readonly destinations: readonly Destination[];
  readonly playbackSettings: FeedDetail["playback_settings"];
  /** Null while the defaults can't be changed here: they read as last saved. */
  readonly editPlayback: (() => void) | null;
  /** Null offline or unadmitted: `not subscribed` then stands alone. */
  readonly subject: FeedActionSubject | null;
  /** The destination's removal, or null where none is offered. */
  readonly removal: (destination: Destination, focus: FeedActionFocus) => ActionDescriptor | null;
  /** Each null draws no line. */
  readonly lines: { readonly checks: ReactNode; readonly additions: ReactNode };
  readonly detailsOpen: boolean;
  readonly onDetails: (open: boolean) => void;
}) {
  const paneId = usePaneRuntime()?.paneId;
  const page = useRef<HTMLElement>(null);
  const name = useRef<HTMLDivElement>(null);
  const names = useRef<HTMLSpanElement>(null);
  const word = useRef<HTMLButtonElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const detailsId = useId();
  usePaneTitleYield(name);
  const singular = feed.kind === "podcast" ? "episode" : "article";
  const authors = selectMediaAuthors(feed.contributors);
  const description = feed.description?.trim() || null;
  // The toggle shows only while it reveals something: the whole standfirst or a detail.
  const toggled = description !== null || groupContributorCredits(feed.contributors).length > 0
    || feed.website_url !== null || feed.feed_url !== null || playbackSettings !== null;
  const ordered = destinations.toSorted((a, b) => Number(b.is_default) - Number(a.is_default)
    || compareLibraryNames({ id: a.library_id, name: a.name }, { id: b.library_id, name: b.name }));
  const landmark = () => findPaneLandmarkFocusTarget(paneId);
  // Where the word's focus goes once it has withdrawn: a subscription that landed published its first name.
  const firstName = () => names.current?.querySelector<HTMLElement>("a[data-pane-label-hint]") ?? landmark();
  return <section ref={page} className={styles.page} tabIndex={-1}>
    {feed.image_url === null ? null : <Wash key={feed.image_url} url={feed.image_url} />}
    <Artwork title={feed.title} source={remoteArtwork(feed.image_url)} size="fill" className={styles.cover} />
    <div className={styles.head}>
      <div ref={name} className={styles.name} aria-hidden="true" dir="auto">{feed.title}</div>
      <p className={styles.byline}>
        <ContributorCreditList credits={authors} />
        {authors.length > 0 ? " · " : null}
        {`${knownCount.toLocaleString()} ${knownCount === 1 ? singular : `${singular}s`}`}
      </p>
    </div>
    <div className={styles.body}>
      {description === null ? null : <p className={styles.standfirst} data-open={detailsOpen || undefined}>{description}</p>}
      {toggled ? <><Button ref={toggle} className={styles.word} aria-expanded={detailsOpen} aria-controls={detailsId}
        onClick={() => {
          if (detailsOpen && panel.current?.contains(document.activeElement)) toggle.current?.focus();
          onDetails(!detailsOpen);
        }}>{detailsOpen ? "less" : "more"}</Button>
      <div id={detailsId} ref={panel} hidden={!detailsOpen}>
        {detailsOpen ? <div className={styles.details}>
          <ContributorRoleGroups credits={feed.contributors} />
          <div className={styles.facts}>
            {feed.website_url !== null ? <a href={feed.website_url} target="_blank" rel="noopener noreferrer">website</a> : null}
            {feed.feed_url === null ? null : <a href={feed.feed_url} target="_blank" rel="noopener noreferrer">rss feed</a>}
          </div>
          {playbackSettings !== null ? <div className={styles.facts}>
            <span>playback defaults · {formatPlaybackRate(playbackSettings.default_playback_speed ?? 1)} · skip silence on android: {playbackSettings.pause_shortening_mode === "Natural" ? "on" : "off"}</span>
            {editPlayback !== null ? <Button onClick={editPlayback}>edit…</Button> : <span>at last catalog save</span>}
          </div> : null}
        </div> : null}
      </div></> : null}
    </div>
    <Ledger className={styles.lines}>
      {ordered.length > 0 ? <SubscribedIn ordered={ordered} names={names} word={word} page={page} landmark={landmark} removal={removal} />
        : <LedgerLine label="not subscribed">
          {subject === null ? null : <SubscribeWord subject={subject} control={word}
            returnFocus={() => (word.current?.isConnected ? word.current : null) ?? firstName()}
            recover={firstName} />}
        </LedgerLine>}
      {lines.checks === null ? null : <LedgerLine label="checks">{lines.checks}</LedgerLine>}
      {lines.additions === null ? null : <LedgerLine label="additions">{lines.additions}</LedgerLine>}
    </Ledger>
  </section>;
}

/** The libraries the show is followed in, each a link; a named one carries its removal. The
 * line owns where focus ends after a removal: a review closes either before or after the
 * removal's read lands, so a sole name may hold focus until this line withdraws, and the
 * withdrawal passes it to the word that replaced the line, else the pane landmark. */
function SubscribedIn({ ordered, names, word, page, landmark, removal }: {
  readonly ordered: readonly Destination[];
  readonly names: RefObject<HTMLSpanElement | null>;
  readonly word: RefObject<HTMLButtonElement | null>;
  readonly page: RefObject<HTMLElement | null>;
  readonly landmark: () => HTMLElement | null;
  readonly removal: (destination: Destination, focus: FeedActionFocus) => ActionDescriptor | null;
}) {
  const subscribe = () => word.current?.isConnected ? word.current : null;
  useFocusReturn(names, () => subscribe() ?? landmark());
  const link = (libraryId: string) => [...names.current?.querySelectorAll<HTMLElement>("a[data-pane-label-hint]") ?? []]
    .find(node => node.getAttribute("href") === `/libraries/${libraryId}`) ?? null;
  // The order this render showed: neighbours are chosen from it among the links still standing.
  const ids = ordered.map(destination => destination.library_id);
  return <LedgerLine label="subscribed in"><span ref={names}>{ordered.map((destination, index) => {
    const label = libraryDisplayName(destination);
    const href = `/libraries/${destination.library_id}`;
    const action = removal(destination, {
      trigger: null,
      returnFocus: () => link(destination.library_id) ?? page.current,
      afterRemoval: () => ids.slice(index + 1).map(id => link(id)).find(node => node !== null)
        ?? ids.slice(0, index).reverse().map(id => link(id)).find(node => node !== null)
        ?? subscribe() ?? link(destination.library_id) ?? landmark(),
    });
    return <Fragment key={destination.library_id}>
      {index > 0 ? " · " : null}
      {action === null ? <a href={href} data-pane-label-hint={label}>{label}</a>
        : <ContextualActionMenu navigation={null} title={label} subjectKey={`subscription:${destination.subscription_id}`}
          sections={[{ id: "Occurrence", actions: [action] }]} label={`actions for ${label}`}
          renderContextAnchor={context => <a {...context} className={styles.held} href={href} data-pane-label-hint={label}>{label}</a>} />}
    </Fragment>;
  })}</span></LedgerLine>;
}

/** The cover again, behind the page. Keyed by its source at the call site, so each source starts
 * unloaded; it paints only while this image has loaded with a width, never after an error. */
function Wash({ url }: { readonly url: string }) {
  const [loaded, setLoaded] = useState(false);
  return <MediaImage kind="proxied" remoteUrl={url} alt="" aria-hidden="true" className={styles.wash} data-loaded={loaded || undefined}
    onLoad={event => setLoaded(event.currentTarget.naturalWidth > 0)} onError={() => setLoaded(false)} />;
}

/** The subscription review, opened from the line that says the show is not followed. When the
 * word withdraws holding focus (a subscription landed, or the subject left), `recover` takes it. */
function SubscribeWord({ subject, control, returnFocus, recover }: {
  readonly subject: FeedActionSubject;
  readonly control: RefObject<HTMLButtonElement | null>;
  readonly returnFocus: () => HTMLElement | null;
  readonly recover: () => HTMLElement | null;
}) {
  const [action] = useFeedActions(subject);
  const reasonId = useId();
  useActionFocusRecovery(control, recover);
  return <>
    <Button ref={control} className={styles.word} aria-haspopup="dialog"
      aria-disabled={action.disabled || undefined} aria-describedby={action.disabledReason ? reasonId : undefined}
      tooltip={action.disabledReason && !action.waiting ? { text: action.disabledReason } : undefined}
      onClick={event => { if (!action.disabled) action.invoke({ trigger: event.currentTarget, returnFocus, afterRemoval: returnFocus }); }}>subscribe…</Button>
    {action.disabledReason ? <span className="sr-only" id={reasonId}>{action.disabledReason}</span> : null}
  </>;
}
