"use client";

// Every unit of a text publication mounted in one scroll. Units off screen
// skip rendering (content-visibility) at an estimated height. The surface
// reports viewports, positions to targets (then pins the arrival against
// late layout for up to 3s), paints decorations as custom highlights and
// turns clicks into links, notes and marks; only a time stamp seeks.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import HtmlRenderer from "@/components/HtmlRenderer";
import type { DocumentReaderViewProps } from "../DocumentReader";
import { clock, type ReaderTarget, type Structure, type TextDocument } from "../model";
import type { NavOutcome } from "../navigator";
import type { ReaderRuntime, SurfaceHandle } from "../runtime";
import { nextFrame, useScrollport } from "../scrollport";
import { createTextFind } from "./find";
import { createTextGeometry, type TextGeometry } from "./geometry";
import { createPainter, type Painter } from "./paint";
import styles from "../documentReader.module.css";

const PIN_MS = 3_000;

/** An epub link to another spine unit, or a same-unit fragment link. */
function linkTarget(link: HTMLAnchorElement): ReaderTarget | null {
  const { nexusFragmentId: unit, nexusAnchorId: id } = link.dataset;
  if (unit) {
    return id
      ? { kind: "anchor", unit, id }
      : { kind: "point", point: { kind: "text", unit, offset: 0 } };
  }
  const href = link.getAttribute("href") ?? "";
  const owner =
    link.closest<HTMLElement>("[data-reader-unit]")?.dataset.readerUnit;
  return href.length > 1 && href.startsWith("#") && owner
    ? { kind: "anchor", unit: owner, id: decodeURIComponent(href.slice(1)) }
    : null;
}

export default function TextSurface({
  runtime,
  doc,
  structure,
  view,
}: {
  readonly runtime: ReaderRuntime;
  readonly doc: TextDocument;
  readonly structure: Structure;
  readonly view: DocumentReaderViewProps;
}) {
  const scrollport = useRef<HTMLDivElement>(null);
  const lead = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const geometry = useRef<TextGeometry | null>(null);
  const painter = useRef<Painter | null>(null);
  const pin = useRef<{
    to: Parameters<SurfaceHandle["position"]>[0];
    until: number;
  } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const hovered = useRef("");
  const selecting = useRef(false);
  const [embeds, setEmbeds] = useState<
    readonly (readonly [string, HTMLElement])[]
  >([]);
  const { profile, decorations, isMobile } = view;
  const selectable = view.onSelection !== undefined;
  const embedded = view.renderEmbed !== undefined;
  // Estimated px per codepoint: one line of the column holds about its width in characters.
  const density =
    (profile.font_size_px * profile.line_height) / profile.column_width_ch;

  const measure = useCallback(() => {
    const capture = geometry.current?.capture();
    if (!capture) return;
    runtime.viewport(capture.viewport);
    const { primary } = capture.viewport;
    painter.current?.focus(
      viewRef.current.profile.focus_mode,
      primary.kind === "text" ? primary : null,
      selecting.current,
    );
  }, [runtime]);
  useScrollport(scrollport, runtime, measure);

  useLayoutEffect(() => {
    const port = scrollport.current!;
    const text = createTextGeometry(port, column.current!, doc);
    const paint = createPainter(port, text, doc.identity);
    geometry.current = text;
    painter.current = paint;
    paint.paint(viewRef.current.decorations);
    const handle: SurfaceHandle = {
      find: createTextFind(doc, structure, text, paint, runtime),
      capture() {
        const capture = text.capture();
        return capture && { ...capture.placement, identity: doc.identity };
      },
      async position(to, signal): Promise<NavOutcome> {
        if ("identity" in to && to.identity !== doc.identity) {
          return { kind: "Unavailable", reason: "SourceChanged" };
        }
        const before = port.scrollTop;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          if (signal.aborted) return { kind: "Cancelled" };
          if (!text.scrollTo(to))
            return { kind: "Unavailable", reason: "TargetUnavailable" };
          await nextFrame(signal);
          if (signal.aborted) return { kind: "Cancelled" };
          if (text.arrived(to)) {
            pin.current = { to, until: performance.now() + PIN_MS };
            return {
              kind:
                Math.abs(port.scrollTop - before) < 1 ? "Unchanged" : "Arrived",
            };
          }
        }
        return { kind: "Unavailable", reason: "PositioningFailed" };
      },
    };
    const detach = runtime.attach(handle);
    // Late layout (images, fonts, units at their real height, the host's
    // content above the text) keeps an arrival in place.
    const unpin = () => {
      pin.current = null;
    };
    const observer = new ResizeObserver(() => {
      const held = pin.current;
      if (held && performance.now() < held.until) text.scrollTo(held.to);
      measure();
    });
    observer.observe(column.current!);
    if (lead.current) observer.observe(lead.current);
    for (const name of ["wheel", "touchstart", "keydown", "pointerdown"])
      port.addEventListener(name, unpin);
    measure();
    return () => {
      detach();
      observer.disconnect();
      paint.dispose();
      for (const name of ["wheel", "touchstart", "keydown", "pointerdown"])
        port.removeEventListener(name, unpin);
      geometry.current = null;
      painter.current = null;
    };
  }, [doc, measure, runtime, structure]);

  useEffect(() => painter.current?.paint(decorations), [decorations]);
  useEffect(measure, [measure, profile.focus_mode]);

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
  }, [doc, runtime]);

  // A live selection suspends focus dimming; the capture reaches the host settled.
  useEffect(() => {
    let timer: number | undefined;
    const change = () => {
      const selection = document.getSelection();
      const inside = Boolean(
        selection?.anchorNode &&
        !selection.isCollapsed &&
        column.current?.contains(selection.anchorNode),
      );
      if (inside !== selecting.current) {
        selecting.current = inside;
        measure();
      }
      if (!selectable) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => {
          const capture =
            (inside && geometry.current?.selection(selection!)) || null;
          viewRef.current.onSelection?.(capture);
        },
        isMobile ? 400 : 120,
      );
    };
    document.addEventListener("selectionchange", change);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", change);
    };
  }, [isMobile, measure, selectable]);

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
  }, [doc, embedded]);

  function click(event: MouseEvent<HTMLDivElement>) {
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
    const to = link && linkTarget(link);
    if (to) {
      event.preventDefault();
      void runtime.inspect(to);
      return;
    }
    if (link?.getAttribute("href") === "#") event.preventDefault();
    if (!document.getSelection()?.isCollapsed) return;
    const ids = painter.current?.hit(event.clientX, event.clientY) ?? [];
    const rect = new DOMRect(event.clientX, event.clientY, 0, 0);
    if (ids.length > 0) onMarks?.({ kind: "activate", ids, rect });
  }

  /** Hover hit-tests marks under a mouse; only a change is reported. */
  function hover(event: MouseEvent<HTMLDivElement>) {
    const ids = painter.current?.hit(event.clientX, event.clientY) ?? [];
    event.currentTarget.style.cursor = ids.length ? "pointer" : "";
    if (ids.join(" ") === hovered.current) return;
    hovered.current = ids.join(" ");
    const rect = new DOMRect(event.clientX, event.clientY, 0, 0);
    viewRef.current.onMarks?.({ kind: "hover", ids, rect });
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
        {doc.units.map((unit) => (
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
