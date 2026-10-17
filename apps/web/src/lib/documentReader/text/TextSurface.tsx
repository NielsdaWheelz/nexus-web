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
import type { DocumentReaderViewProps } from "../DocumentReader";
import { clock, type Placement, type Structure, type TextDocument } from "../model";
import type { NavOutcome } from "../navigator";
import type { ReaderRuntime, SurfaceHandle } from "../runtime";
import { useReaderSelection } from "../selection";
import { measureScrollport, nextFrame, useScrollport } from "../scrollport";
import { createTextFind } from "./find";
import { createTextGeometry, type TextGeometry } from "./geometry";
import { createPainter, type Painter } from "./paint";
import { readerLinkTarget } from "./linkTarget";
import styles from "../documentReader.module.css";

export default function TextSurface({
  runtime,
  doc,
  structure,
  view,
  scrollIndicator,
}: {
  readonly runtime: ReaderRuntime;
  readonly doc: TextDocument;
  readonly structure: Structure;
  readonly view: DocumentReaderViewProps;
  readonly scrollIndicator: RefObject<HTMLDivElement | null>;
}) {
  const { identity, format, units, sections, length } = doc;
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
  const selecting = useRef(false);
  const [embeds, setEmbeds] = useState<
    readonly (readonly [string, HTMLElement])[]
  >([]);
  const { profile, decorations, activePassage, isMobile } = view;
  const embedded = view.renderEmbed !== undefined;
  // Estimated px per codepoint: one line of the column holds about its width in characters.
  const density =
    (profile.font_size_px * profile.line_height) / profile.column_width_ch;

  const measure = useCallback(() => {
    const capture = geometry.current?.capture();
    if (!capture) return;
    placement.current = { ...capture.placement, identity: doc.identity };
    runtime.viewport(capture.viewport);
    const { primary } = capture.viewport;
    painter.current?.focus(
      viewRef.current.profile.focus_mode,
      primary.kind === "text" ? primary : null,
      selecting.current || viewRef.current.activePassage?.identity === doc.identity,
    );
  }, [doc.identity, runtime]);
  useScrollport(scrollport, runtime, measure, scrollIndicator);
  const selectionInput = useReaderSelection(scrollport, {
    identity,
    textSelector: "[data-reader-text]",
    capture(selection) {
      return geometry.current?.selection(selection) ?? null;
    },
    onSelection: view.onSelection,
    onSelecting(inside) {
      if (inside === selecting.current) return;
      selecting.current = inside;
      measure();
    },
  });

  useLayoutEffect(() => {
    const port = scrollport.current!;
    const text = createTextGeometry(port, column.current!, { units, length });
    const paint = createPainter(port, text, identity);
    geometry.current = text;
    painter.current = paint;
    paint.paint(viewRef.current.decorations, viewRef.current.activePassage, viewRef.current.inspection);
    const handle: SurfaceHandle = {
      identity,
      find: createTextFind(
        { identity, format, sections, units, length }, structure, text, paint, runtime,
      ),
      measurePassage(passage) {
        return passage.identity === identity && passage.anchor.kind === "text"
          ? text.measurePassage(passage.anchor)
          : null;
      },
      measureBounds() {
        return measureScrollport(port);
      },
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
        try {
          for (let attempt = 0; attempt < 12; attempt += 1) {
            if (signal.aborted) return { kind: "Cancelled" };
            if (!text.scrollTo(to))
              return { kind: "Unavailable", reason: "TargetUnavailable" };
            await nextFrame(signal);
            if (signal.aborted) return { kind: "Cancelled" };
            if (text.arrived(to)) {
              placement.current = handle.capture();
              return {
                kind:
                  Math.abs(port.scrollTop - before) < 1 ? "Unchanged" : "Arrived",
              };
            }
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
    const observer = new ResizeObserver(() => {
      void runtime.reflow({ placement: placement.current, change: measure });
    });
    observer.observe(port);
    observer.observe(column.current!);
    if (lead.current) observer.observe(lead.current);
    measure();
    return () => {
      detach();
      observer.disconnect();
      paint.dispose();
      placement.current = null;
      geometry.current = null;
      painter.current = null;
    };
  }, [identity, format, sections, units, length, measure, runtime, structure]);

  useLayoutEffect(() => painter.current?.paint(decorations, activePassage, view.inspection), [decorations, activePassage, view.inspection]);
  useLayoutEffect(measure, [measure, profile.focus_mode, activePassage]);

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
  useEffect(() => {
    if (!embedded) return;
    const slots = [
      ...column.current!.querySelectorAll<HTMLElement>(
        "[data-nexus-document-embed-id]",
      ),
    ].map((placeholder) => {
      const slot = document.createElement("div");
      slot.setAttribute("data-document-embed-ui", "");
      placeholder.append(slot);
      return [placeholder.dataset.nexusDocumentEmbedId!, slot] as const;
    });
    setEmbeds(slots);
    return () => {
      for (const [, slot] of slots) slot.remove();
      setEmbeds([]);
    };
  }, [identity, units, embedded]);

  function click(event: MouseEvent<HTMLDivElement>) {
    if (!document.getSelection()?.isCollapsed) return;
    const target = event.target as Element;
    const { onApparatus, onMarks } = viewRef.current;
    const note = target.closest<HTMLElement>("[data-reader-apparatus-item-id]");
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (
      note &&
      onApparatus &&
      (!link || link.contains(note) || note.contains(link))
    ) {
      event.preventDefault();
      onApparatus(
        note.dataset.readerApparatusItemId!,
        note.getBoundingClientRect(),
        "activate",
      );
      return;
    }
    const to = link && readerLinkTarget(link);
    if (to) {
      event.preventDefault();
      void runtime.inspect({ target: to });
      return;
    }
    if (link?.getAttribute("href") === "#") event.preventDefault();
    const ids = painter.current?.hit(event.clientX, event.clientY) ?? [];
    const current = viewRef.current.decorations;
    const marks = current?.identity === identity
      ? ids.flatMap((id) => current.marks.filter((mark) => mark.id === id))
      : [];
    if (marks.length) onMarks?.({
      kind: "activate", identity, marks,
      input: event.detail === 0 ? "keyboard" : selectionInput.current,
    });
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
        onMouseMove={view.onMarks && !isMobile ? hover : undefined}
      >
        {units.map((unit) => (
          <section
            key={unit.id}
            data-reader-unit={unit.id}
            className={styles.unit}
            style={{
              containIntrinsicSize: `auto ${Math.ceil(24 + unit.length * density)}px`,
            }}
          >
            {unit.time ? (
              <p className={styles.time}>
                {view.onSeekTime ? (
                  <button
                    type="button"
                    onClick={() => {
                      // Choosing a segment's time reads from there and seeks the player.
                      runtime.readFrom({ kind: "text", unit: unit.id, offset: 0 });
                      view.onSeekTime?.(unit.time!.startMs);
                    }}
                  >
                    {clock(unit.time.startMs)}
                  </button>
                ) : (
                  clock(unit.time.startMs)
                )}
                {unit.speaker ? ` · ${unit.speaker}` : null}
              </p>
            ) : null}
            <div data-reader-text="">
              <HtmlRenderer htmlSanitized={unit.html} headingLevelOffset={1} />
            </div>
          </section>
        ))}
        {view.end ? <section className={styles.end}>{view.end}</section> : null}
      </div>
      {embeds.map(([id, slot]) =>
        createPortal(view.renderEmbed?.(id), slot, id),
      )}
    </div>
  );
}
