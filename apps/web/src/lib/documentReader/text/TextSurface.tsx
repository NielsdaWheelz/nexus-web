"use client";

// Every unit of a text publication mounted in one scroll. Units off screen
// skip rendering (content-visibility) at an estimated height. The surface
// reports viewports, preserves the measured passage through layout changes,
// paints decorations as custom highlights and
// turns clicks into links, notes and marks; only a time stamp seeks.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import HtmlRenderer from "@/components/HtmlRenderer";
import { isInteractiveTarget } from "@/lib/ui/eventTarget";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import type { DocumentReaderViewProps } from "../DocumentReader";
import { ArticleContentNotice } from "../chrome/ArticleContentNotice";
import { clock, sourceTarget, type Placement, type Structure, type TextDocument, type TextUnit } from "../model";
import type { NavOutcome } from "../navigator";
import type { ReaderRuntime, SurfaceHandle } from "../runtime";
import { useReaderSelection } from "../selection";
import { measureScrollport, nextFrame, useScrollport } from "../scrollport";
import { createTextFind, type TextFind } from "./find";
import { createTextGeometry, type TextGeometry } from "./geometry";
import { createPainter, type Painter } from "./paint";
import { readerLinkTarget } from "./linkTarget";
import { activateReaderDestination, ReaderLink } from "../navigation";
import type { ReaderDestination } from "../location";
import styles from "../documentReader.module.css";

export default function TextSurface({
  runtime,
  doc,
  structure,
  view,
  scrollIndicator,
  feedback,
}: {
  readonly runtime: ReaderRuntime;
  readonly doc: TextDocument;
  readonly structure: Structure;
  readonly view: DocumentReaderViewProps;
  readonly scrollIndicator: RefObject<HTMLDivElement | null>;
  readonly feedback: RefObject<HTMLDivElement | null>;
}) {
  const { identity, format, units, length, ranges } = doc;
  const inputs = useRef({ doc, structure });
  inputs.current = { doc, structure };
  const finder = useRef<TextFind | null>(null);
  const scrollport = useRef<HTMLDivElement>(null);
  const lead = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const geometry = useRef<TextGeometry | null>(null);
  const painter = useRef<Painter | null>(null);
  // A resize is observed after layout. Keep the last measured point and
  // pixel offset so the navigator can preserve the passage from before it.
  const placement = useRef<Placement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const hovered = useRef("");
  const linkDestinations = useRef(new WeakMap<HTMLAnchorElement, ReaderDestination>());
  const selecting = useRef(false);
  const [embeds, setEmbeds] = useState<
    readonly (readonly [string, HTMLElement])[]
  >([]);
  const { profile, decorations, activePassage, isMobile } = view;
  const embedded = view.renderEmbed !== undefined || doc.embeds.some((embed) => embed.provider === "x") || units.some((unit) => unit.xPost?.embed_occurrence_key !== null && unit.xPost?.embed_occurrence_key !== undefined);
  // Estimated px per codepoint: one line of the column holds about its width in characters.
  const density =
    (profile.font_size_px * profile.line_height) / profile.column_width_ch;

  const measure = useCallback((cause: "Observation" | "Geometry") => {
    const capture = geometry.current?.capture();
    if (!capture) return;
    placement.current = { ...capture.placement, identity: doc.identity };
    runtime.viewport(capture.viewport, capture.placement, cause, null);
    if (finder.current) runtime.updateFind(finder.current.update(inputs.current.doc, inputs.current.structure));
    const { primary } = capture.viewport;
    painter.current?.focus(
      viewRef.current.profile.focus_mode,
      primary.kind === "text" ? primary : null,
      selecting.current || viewRef.current.activePassage?.identity === doc.identity,
    );
  }, [doc.identity, runtime]);
  const { geometryChanged, retireReflow } = useScrollport(scrollport, runtime, measure, { placement, change: () => measure("Geometry") }, scrollIndicator, feedback);
  const { input: selectionInput, captureSelection } = useReaderSelection(scrollport, {
    identity,
    textSelector: "[data-reader-text]",
    capture(selection) {
      return geometry.current?.selection(selection) ?? null;
    },
    onSelection: view.onSelection,
    onSelecting(inside) {
      if (inside === selecting.current) return;
      selecting.current = inside;
      measure("Geometry");
    },
  });

  useLayoutEffect(() => {
    const port = scrollport.current!;
    const text = createTextGeometry(port, column.current!, { units, length, ranges });
    const paint = createPainter(port, text, identity);
    geometry.current = text;
    painter.current = paint;
    paint.paint(viewRef.current.decorations, viewRef.current.activePassage, viewRef.current.inspection);
    const find = createTextFind(inputs.current.doc, inputs.current.structure, text, paint, runtime);
    finder.current = find;
    const handle: SurfaceHandle = {
      identity,
      retireReflow,
      find: find.source,
      measurePassage(passage) {
        return passage.identity === identity && passage.anchor.kind === "text"
          ? text.measurePassage(passage.anchor)
          : null;
      },
      measureBounds() {
        return measureScrollport(port);
      },
      captureSelection,
      focusSource() {
        port.focus({ preventScroll: true });
      },
      capture() {
        const capture = text.capture();
        return capture && { ...capture.placement, identity };
      },
      async position(to, signal): Promise<NavOutcome> {
        if ("identity" in to && to.identity !== identity) {
          return { kind: "Unavailable", reason: "SourceChanged" };
        }
        const before = port.scrollTop;
        const release = text.realize(to);
        const arrived = (): NavOutcome => {
          placement.current = handle.capture();
          return {
            kind: Math.abs(port.scrollTop - before) < 1 ? "Unchanged" : "Arrived",
          };
        };
        try {
          if (signal.aborted) return { kind: "Cancelled" };
          // A resize below the passage needs no correction. Waiting a frame
          // here would mistake continuing native inertia for a failed move.
          if (text.arrived(to)) return arrived();
          for (let attempt = 0; attempt < 12; attempt += 1) {
            if (signal.aborted) return { kind: "Cancelled" };
            if (!text.scrollTo(to))
              return { kind: "Unavailable", reason: "TargetUnavailable" };
            await nextFrame(signal);
            if (signal.aborted) return { kind: "Cancelled" };
            if (text.arrived(to)) return arrived();
          }
          return { kind: "Unavailable", reason: "PositioningFailed" };
        } finally {
          release();
        }
      },
    };
    const detach = runtime.attach(handle);
    // Width, typography, images, realised units and host chrome all change
    // geometry. The same navigator fence owns every resulting adjustment;
    // an active jump retains its target and later genuine input cancels it.
    const observer = new ResizeObserver(() => geometryChanged("Layout"));
    observer.observe(port);
    observer.observe(column.current!);
    if (lead.current) observer.observe(lead.current);
    measure("Geometry");
    return () => {
      detach();
      observer.disconnect();
      paint.dispose();
      placement.current = null;
      geometry.current = null;
      painter.current = null;
      finder.current = null;
    };
  }, [identity, format, units, length, ranges, measure, runtime, embeds, geometryChanged, retireReflow, captureSelection]);

  useLayoutEffect(() => {
    if (finder.current) runtime.updateFind(finder.current.update(doc, structure));
  }, [doc, structure, runtime]);

  useLayoutEffect(() => painter.current?.paint(decorations, activePassage, view.inspection), [decorations, activePassage, view.inspection]);
  useLayoutEffect(() => measure("Geometry"), [measure, profile.focus_mode, activePassage]);

  // Per-unit dom work once a unit nears the viewport (public: token-authorised images).
  useEffect(() => {
    const hydrate = runtime.source.hydrate?.bind(runtime.source);
    if (!hydrate) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          hydrate(entry.target as HTMLElement, controller.signal);
        }
      },
      { root: scrollport.current, rootMargin: "100% 0px" },
    );
    for (const unit of column.current!.querySelectorAll("[data-reader-unit]"))
      observer.observe(unit);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [identity, units, runtime]);

  // Embed cards render into slots inside their placeholders, outside the canonical text.
  useLayoutEffect(() => {
    if (!embedded) return;
    const slots = [
      ...column.current!.querySelectorAll<HTMLElement>(
        "[data-nexus-document-embed-id]",
      ),
    ].map((placeholder) => {
      const id = placeholder.dataset.nexusDocumentEmbedId!;
      const isX = placeholder.dataset.nexusDocumentEmbedKind?.startsWith("x_") ||
        units.some((unit) => unit.xPost?.embed_occurrence_key === id);
      if (isX) placeholder.setAttribute("data-reader-x-slot", "");
      const slot = document.createElement("div");
      slot.setAttribute("data-document-embed-ui", "");
      placeholder.append(slot);
      return [id, slot] as const;
    });
    setEmbeds(slots);
    return () => {
      for (const [, slot] of slots) { slot.parentElement?.removeAttribute("data-reader-x-slot"); slot.remove(); }
      setEmbeds([]);
    };
  }, [identity, units, embedded]);

  const apparatusDestination = view.apparatusDestination;
  useLayoutEffect(() => {
    const changes: { link: HTMLAnchorElement; href: string; rich: string | null; role: string | null; tabIndex: string | null }[] = [];
    const bound = linkDestinations.current;
    for (const link of column.current!.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const note = link.matches("[data-reader-apparatus-item-id]") ? link : link.querySelector<HTMLElement>("[data-reader-apparatus-item-id]");
      const target = readerLinkTarget(link);
      const portable=target?sourceTarget(doc,target):null;
      const destination = note ? apparatusDestination?.(note.dataset.readerApparatusItemId!) ?? null : portable ? { source_identity: identity, target:portable } : null;
      if (!destination) continue;
      changes.push({ link, href: link.getAttribute("href")!, rich: link.getAttribute("data-workspace-rich-target"), role: link.getAttribute("role"), tabIndex: link.getAttribute("tabindex") });
      bound.set(link, destination);
      link.setAttribute("data-workspace-rich-target", "true");
      const href = runtime.navigation?.href(destination);
      if (href) link.setAttribute("href", href);
      else if (runtime.navigation) {
        // A destination beyond the host's URL bound still supports local inspection.
        // Never leave a raw hash that would give native activation another target.
        link.removeAttribute("href");
        link.setAttribute("role", "link");
        link.setAttribute("tabindex", "0");
      }
    }
    return () => { for (const { link, href, rich, role, tabIndex } of changes) {
      link.setAttribute("href", href);
      if (rich === null) link.removeAttribute("data-workspace-rich-target"); else link.setAttribute("data-workspace-rich-target", rich);
      if (role === null) link.removeAttribute("role"); else link.setAttribute("role", role);
      if (tabIndex === null) link.removeAttribute("tabindex"); else link.setAttribute("tabindex", tabIndex);
      bound.delete(link);
    } };
  }, [apparatusDestination, identity, runtime, units,doc]);

  function openLink(event: TargetActivationEvent & { readonly target: EventTarget | null }) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return false;
    const link = element.closest<HTMLAnchorElement>("a");
    const enter = link && linkDestinations.current.has(link) && !link.hasAttribute("href") ? "activate" : "native";
    const note = link ? (link.matches("[data-reader-apparatus-item-id]") ? link : link.querySelector<HTMLElement>("[data-reader-apparatus-item-id]")) : element.closest<HTMLElement>("[data-reader-apparatus-item-id]");
    if (note && viewRef.current.onApparatus) {
      const activation = workspaceTargetActivationIntent(event, enter);
      if (activation.kind === "Unowned") return true;
      event.preventDefault();
      if (activation.kind === "Open") viewRef.current.onApparatus(note.dataset.readerApparatusItemId!, note.getBoundingClientRect(), "activate", activation.intent);
      return true;
    }
    const destination = link && linkDestinations.current.get(link);
    if (destination) activateReaderDestination(runtime, destination, event, undefined, enter);
    return link !== null;
  }

  function click(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented || event.button !== 0 ||
      document.getSelection()?.isCollapsed === false
    ) return;
    if (openLink(event)) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as Element;
    const { onMarks } = viewRef.current;
    if (isInteractiveTarget(target, event.currentTarget)) return;
    const ids = painter.current?.hit(event.clientX, event.clientY) ?? [];
    const current = viewRef.current.decorations;
    const unit = target.closest<HTMLElement>("[data-reader-unit]")?.dataset.readerUnit;
    const marks = current?.identity === identity
      ? ids.flatMap((id) => current.marks.filter((mark) => mark.id === id && (mark.anchor.kind !== "text" || mark.anchor.unit === unit)))
      : [];
    if (marks.length && onMarks) {
      event.preventDefault();
      onMarks({
        kind: "activate", identity, marks,
        input: event.detail === 0 ? "keyboard" : selectionInput.current,
      });
    }
  }

  /** Hover hit-tests marks under a mouse; only a change is reported. */
  function hover(event: MouseEvent<HTMLDivElement>) {
    const ids = painter.current?.hit(event.clientX, event.clientY) ?? [];
    event.currentTarget.style.cursor = ids.length ? "pointer" : "";
    if (ids.join(" ") === hovered.current) return;
    hovered.current = ids.join(" ");
    viewRef.current.onMarks?.({ kind: "hover", ids });
    const note = (event.target as Element).closest<HTMLElement>(
      "[data-reader-apparatus-item-id]",
    );
    if (note)
      viewRef.current.onApparatus?.(
        note.dataset.readerApparatusItemId!,
        note.getBoundingClientRect(),
        "hover",
        null,
      );
  }

  function renderEmbed(id: string) {
    const embed = doc.embeds.find((embed) => embed.occurrence_key === id);
    if (embed?.provider !== "x") return view.renderEmbed?.(id);
    const href = embed.canonical_url.value ?? embed.source_url.value;
    if (embed.kind === "link_preview") return view.renderEmbed?.(id) ?? <p data-reader-metadata="">
      {embed.display.label}{href ? <> · <a href={href} target="_blank" rel="noreferrer">open on x</a></> : null}
    </p>;
    return <p data-reader-metadata="">{embed.display.description}{href ? <> · <a href={href} target="_blank" rel="noreferrer">open on x</a></> : null}</p>;
  }

  function renderUnit(unit: TextUnit) {
    return (
          <section
            key={unit.id}
            data-reader-unit={unit.id}
            data-playback-current={view.playback?.identity === identity && view.playback.unit === unit.id ? "true" : undefined}
            className={styles.unit}
            style={{
              containIntrinsicSize: `auto ${Math.ceil(24 + unit.length * density)}px`,
            }}
          >
            {unit.xPost ? <div className={styles.postMeta} data-reader-metadata="">
              {unit.xPost.relation !== "primary" ? <p>{({ quoted: "quoted post", replied_to: "replying to", retweeted: "reposted post", embedded: "embedded post" } as const)[unit.xPost.relation]}</p> : null}
              <p>{unit.xPost.author.name} · @{unit.xPost.author.username}{unit.xPost.created_at ? ` · ${new Date(unit.xPost.created_at).toLocaleDateString()}` : ""}</p>
              {unit.xPost.is_edited ? <p>edited on x</p> : null}
              {unit.xPost.availability === "unavailable" ? <p>post unavailable on x</p> : null}
              {unit.xPost.checked_in_capture === false ? <p>saved copy · not checked in this refresh</p> : null}
              <div className={styles.postActions}>
                <a href={unit.xPost.source_url} target="_blank" rel="noreferrer">open on x</a>
                {view.renderPostActions?.(unit)}
              </div>
            </div> : null}
            {unit.time ? (
              <p className={styles.time}>
                {view.onSeekTime ? (
                  <ReaderLink reader={runtime} target={{ kind: "time", ms: unit.time.startMs }}
                    aria-current={view.playback?.identity === identity && view.playback.unit === unit.id ? "time" : undefined}
                    aria-label={view.playback?.identity === identity && view.playback.unit === unit.id ? "playback position" : undefined}
                    onDefault={() => {
                      // Choosing a segment's time reads from there and seeks the player.
                      runtime.readFrom({ kind: "text", unit: unit.id, offset: 0 });
                      view.onSeekTime?.(unit.time!.startMs);
                    }}
                  >
                    {clock(unit.time.startMs)}
                  </ReaderLink>
                ) : (
                  <span aria-current={view.playback?.identity === identity && view.playback.unit === unit.id ? "time" : undefined}
                    aria-label={view.playback?.identity === identity && view.playback.unit === unit.id ? "playback position" : undefined}>{clock(unit.time.startMs)}</span>
                )}
                {unit.speaker ? ` · ${unit.speaker}` : null}
              </p>
            ) : null}
            <div data-reader-text="">
              <HtmlRenderer htmlSanitized={unit.html} headingLevelOffset={1} />
            </div>
            {doc.embeds.filter((embed) => embed.locator.unit_id === unit.id).map((embed) =>
              <div key={embed.occurrence_key} data-reader-metadata="" data-document-embed-ui="" className={styles.postMeta}>
                {renderEmbed(embed.occurrence_key)}
              </div>)}
            {unit.xPost?.references.length ? <div className={styles.postMeta} data-reader-metadata="">
              {unit.xPost.references.map((reference) => <p key={`${reference.relation}:${reference.referenced_revision_id}`}>
                {reference.target_unit_id ? <ReaderLink reader={runtime} target={{ kind: "point", point: { kind: "text", unit: reference.target_unit_id, offset: 0 } }}>
                  {({ quoted: "quoted post", replied_to: "replying to", retweeted: "reposted post" } as const)[reference.relation]}
                </ReaderLink> : <a href={reference.source_url} target="_blank" rel="noreferrer">
                  {({ quoted: "quoted post", replied_to: "replying to", retweeted: "reposted post" } as const)[reference.relation]}
                </a>}
                {reference.availability === "unavailable" ? " · post unavailable on x" : reference.availability === "not_captured" ? " · not captured" : null}
              </p>)}
            </div> : null}
            {unit.xPost?.parent_unit_id == null ? units.filter((child) => child.xPost?.parent_unit_id === unit.id && child.xPost.embed_occurrence_key === null).map(renderUnit) : null}
          </section>
    );
  }

  return (
    <div
      ref={scrollport}
      className={styles.scrollport}
      role="region"
      aria-label="Document reading area"
      tabIndex={0}
      data-pane-content="true"
    >
      {view.before ? <div ref={lead}>{view.before}</div> : null}
      <div
        ref={column}
        className={styles.column}
        onClick={click}
        onKeyDown={openLink}
        onMouseMove={view.onMarks && !isMobile ? hover : undefined}
      >
        {doc.xCapture ? <header className={styles.capture} data-reader-metadata="">
          {view.showCaptureTitle !== false ? <h1>{doc.title}</h1> : null}
          <p>{doc.xCapture.primary_post_count} {doc.xCapture.primary_post_count === 1 ? "post" : "posts"} · saved {new Date(doc.xCapture.saved_at).toLocaleDateString()}</p>
          {doc.xCapture.limits.length ? <p>capture limit reached</p> : null}
          {doc.xCapture.unresolved_parent_count > 0 ? <p>some reply connections could not be checked</p> : null}
          {doc.xCapture.unchecked_post_count > 0 ? <p>{doc.xCapture.unchecked_post_count} saved {doc.xCapture.unchecked_post_count === 1 ? "post was" : "posts were"} not checked in this refresh</p> : null}
        </header> : null}
        {doc.xArticleContent ? <div className={styles.capture} data-reader-metadata="">
          <ArticleContentNotice content={doc.xArticleContent} />
        </div> : null}
        {units.filter((unit) => unit.xPost?.parent_unit_id == null).map(renderUnit)}
        {doc.embeds.filter((embed) => embed.provider === "x" && embed.locator.unit_id === null && !embeds.some(([id]) => id === embed.occurrence_key))
          .map((embed) => <div key={embed.occurrence_key} className={styles.postMeta}>{renderEmbed(embed.occurrence_key)}</div>)}
        {view.end ? <section className={styles.end}>{view.end}</section> : null}
      </div>
      {embeds.map(([id, slot]) => {
        const parent = slot.closest<HTMLElement>("[data-reader-unit]")?.dataset.readerUnit;
        const children = units.filter((unit) => unit.xPost?.embed_occurrence_key === id && unit.xPost.parent_unit_id === parent);
        return createPortal(children.length ? children.map(renderUnit) : renderEmbed(id), slot, id);
      })}
    </div>
  );
}
