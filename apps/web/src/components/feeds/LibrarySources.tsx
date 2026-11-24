"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useFocusReturn } from "@/components/feedback/Fact";
import ResourceCover from "@/components/resources/ResourceCover";
import { remoteArtwork } from "@/components/ui/Artwork";
import { Ledger, LedgerLine } from "@/components/ui/Ledger";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectFeedLibraryRemovalAction } from "@/lib/actions/project";
import type { ServerValue } from "@/lib/api/serverState";
import type { LibraryFeedIndex } from "@/lib/feeds/api";
import type { Library } from "@/lib/libraries/api";
import { remoteReady } from "@/lib/native/admission";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import styles from "./LibrarySources.module.css";

/** The aggregate owns order and freshness; this region draws subscriptions alone. */
export default function LibrarySources({ library, source }: { readonly library: Library; readonly source: ServerValue<LibraryFeedIndex> }) {
  return source.status === "ready" && source.data.subscriptions.length > 0
    ? <Sources library={library} source={source} /> : null;
}

function Sources({ library, source }: { readonly library: Library; readonly source: Extract<ServerValue<LibraryFeedIndex>, { status: "ready" }> }) {
  const section = useRef<HTMLElement>(null);
  const paneId = usePaneRuntime()?.paneId;
  useFocusReturn(section, () => findPaneLandmarkFocusTarget(paneId));
  return <section ref={section} className={styles.sources} aria-label="sources" tabIndex={-1}>
    <Ledger>{(["podcast", "article"] as const).map(kind => {
      const subscriptions = source.data.subscriptions.filter(show => show.feed.kind === kind);
      return subscriptions.length > 0 ? <SourceLine key={kind} kind={kind} library={library}
        subscriptions={subscriptions} source={source} section={section} /> : null;
    })}</Ledger>
  </section>;
}

function SourceLine({ kind, library, subscriptions, source, section }: {
  readonly kind: "podcast" | "article";
  readonly library: Library;
  readonly subscriptions: LibraryFeedIndex["subscriptions"];
  readonly source: Extract<ServerValue<LibraryFeedIndex>, { status: "ready" }>;
  readonly section: RefObject<HTMLElement | null>;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const word = useRef<HTMLAnchorElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  const paneId = usePaneRuntime()?.paneId;
  const noun = kind === "podcast" ? "podcasts" : "feeds";
  const href = library.is_default ? `/${noun}?sort=alpha` : `/${noun}?library_id=${encodeURIComponent(library.id)}&sort=alpha`;
  const home = () => word.current ?? section.current ?? findPaneLandmarkFocusTarget(paneId);
  useFocusReturn(strip, home);
  useFocusReturn(word, () => section.current ?? findPaneLandmarkFocusTarget(paneId));
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => {
      const cover = element.querySelector<HTMLAnchorElement>("a");
      if (!cover) return;
      const size = parseFloat(getComputedStyle(cover).inlineSize);
      const gap = parseFloat(getComputedStyle(element).columnGap);
      setFit(Math.max(2, Math.floor((element.clientWidth + gap) / (size + gap))));
    };
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(element);
    return () => sizes.disconnect();
  }, []);
  const count = subscriptions.length;
  const shown = fit === null ? Math.min(count, 12) : count <= fit ? count : fit - 1;
  const more = fit !== null && count > fit ? count - shown : 0;
  const blocked = source.source.kind !== "live" || !remoteReady() || source.error !== null || source.refreshing || !source.fresh
    ? "TemporarilyUnavailable" : null;
  return <LedgerLine label={<><a ref={word} href={href}>{noun}</a><span> · {count}</span></>}>
    <ul ref={strip} className={styles.strip}>
      {subscriptions.slice(0, shown).map((show, index) => <SourceCover key={show.feed.id} show={show} library={library}
        source={source} blocked={blocked} section={section}
        afterRemoval={() => {
          const neighbors = [...subscriptions.slice(index + 1), ...subscriptions.slice(0, index).reverse()];
          for (const neighbor of neighbors) {
            const link = strip.current?.querySelector<HTMLAnchorElement>(`a[href="/${noun}/${CSS.escape(neighbor.feed.id)}"]`);
            if (link) return link;
          }
          return home();
        }} />)}
      {more > 0 ? <li><a className={styles.more} href={href} aria-label={`${more} more ${noun}`}>+{more}</a></li> : null}
    </ul>
  </LedgerLine>;
}

/** A cover's lifetime owns recovery after an accepted removal or a narrower strip. */
function SourceCover({ show, library, source, blocked, section, afterRemoval }: {
  readonly show: LibraryFeedIndex["subscriptions"][number];
  readonly library: Library;
  readonly source: Extract<ServerValue<LibraryFeedIndex>, { status: "ready" }>;
  readonly blocked: "TemporarilyUnavailable" | null;
  readonly section: RefObject<HTMLElement | null>;
  readonly afterRemoval: () => HTMLElement | null;
}) {
  const root = useRef<HTMLLIElement>(null);
  const { ctx, run } = useActionRuntime();
  const paneId = usePaneRuntime()?.paneId;
  useFocusReturn(root, afterRemoval);
  const { feed } = show;
  const removal = !library.is_default && source.source.kind === "live" ? projectFeedLibraryRemovalAction({
    feedId: feed.id, feedKind: feed.kind, title: feed.title, libraryId: library.id, libraryName: library.name,
    canRemove: source.data.can_add_content, blocked, ctx, run,
    focus: {
      get trigger() { return root.current?.querySelector<HTMLAnchorElement>("a") ?? null; },
      returnFocus: () => root.current?.querySelector<HTMLAnchorElement>("a") ?? section.current ?? findPaneLandmarkFocusTarget(paneId),
      afterRemoval,
    },
  }) : undefined;
  const noun = feed.kind === "podcast" ? "podcast" : "feed";
  return <li ref={root}><ResourceCover resourceRef={`${feed.kind === "podcast" ? "podcast" : "feed"}:${feed.id}`} href={`/${feed.kind === "podcast" ? "podcasts" : "feeds"}/${feed.id}`}
    title={feed.title} label={`${noun}: ${feed.title}`} source={remoteArtwork(feed.image_url)} removal={removal}
    subjectKey={`library:${library.id}:${feed.id}`} className={styles.cover} /></li>;
}
