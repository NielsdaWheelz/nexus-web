"use client";

// Every unit of a text publication mounted in one scroll. Units off screen
// skip rendering (content-visibility) at an estimated height. The surface
// reports viewports, positions to targets (then pins the arrival against
// late layout for up to 3s), paints decorations and turns clicks into links,
// notes, marks and time seeks.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import HtmlRenderer from "@/components/HtmlRenderer";
import type { DocumentReaderViewProps } from "../DocumentReader";
import type { ReaderTarget, TextDocument } from "../model";
import type { NavOutcome } from "../navigator";
import type { ReaderRuntime, SurfaceHandle } from "../runtime";
import { nextFrame, useScrollport } from "../scrollport";
import { createTextGeometry, type TextGeometry } from "./geometry";
import { createPainter, type Painter } from "./paint";
import styles from "../documentReader.module.css";

const PIN_MS = 3_000;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const mmss = `${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : mmss;
};

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
  view,
}: {
  readonly runtime: ReaderRuntime;
  readonly doc: TextDocument;
  readonly view: DocumentReaderViewProps;
}) {
  const scrollport = useRef<HTMLDivElement>(null);
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
    if (capture) runtime.viewport(capture.viewport);
  }, [runtime]);
  useScrollport(scrollport, runtime, measure);

  useLayoutEffect(() => {
    const port = scrollport.current!;
    const text = createTextGeometry(port, column.current!, doc);
    geometry.current = text;
    painter.current = createPainter(column.current!, text, doc.identity);
    painter.current.paint(viewRef.current.decorations);
    const handle: SurfaceHandle = {
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
    // Late layout (images, fonts, units rendering at their real height) keeps an arrival in place.
    const unpin = () => {
      pin.current = null;
    };
    const observer = new ResizeObserver(() => {
      const held = pin.current;
      if (held && performance.now() < held.until) text.scrollTo(held.to);
      measure();
    });
    observer.observe(column.current!);
    for (const name of ["wheel", "touchstart", "keydown", "pointerdown"])
      port.addEventListener(name, unpin);
    measure();
    return () => {
      detach();
      observer.disconnect();
      for (const name of ["wheel", "touchstart", "keydown", "pointerdown"])
        port.removeEventListener(name, unpin);
      geometry.current = null;
    };
  }, [doc, measure, runtime]);

  useEffect(() => painter.current?.paint(decorations), [decorations]);

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

  useEffect(() => {
    if (!selectable) return;
    let timer: number | undefined;
    let open = false;
    const change = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => {
          const selection = document.getSelection();
          const inside =
            selection?.anchorNode &&
            column.current?.contains(selection.anchorNode);
          const capture =
            (inside && geometry.current?.selection(selection!)) || null;
          if (capture || open) viewRef.current.onSelection?.(capture);
          open = capture !== null;
        },
        isMobile ? 400 : 120,
      );
    };
    document.addEventListener("selectionchange", change);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", change);
    };
  }, [isMobile, selectable]);

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
    const ids = painter.current?.hit(target) ?? [];
    if (ids.length > 0)
      onMarks?.({
        kind: "activate",
        ids,
        rect: target.getBoundingClientRect(),
      });
  }

  function hover(event: PointerEvent<HTMLDivElement>) {
    const { onMarks, onApparatus } = viewRef.current;
    if (event.pointerType !== "mouse") return;
    const target =
      event.type === "pointerover" ? (event.target as Element) : null;
    const ids = painter.current?.hit(target) ?? [];
    // Report only a change of the hovered marks, not every pointer crossing.
    if (ids.join(" ") !== hovered.current) {
      hovered.current = ids.join(" ");
      onMarks?.({
        kind: "hover",
        ids,
        rect: ids.length ? target!.getBoundingClientRect() : null,
      });
    }
    const note = target?.closest<HTMLElement>(
      "[data-reader-apparatus-item-id]",
    );
    if (note)
      onApparatus?.(
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
      {view.before}
      <div
        ref={column}
        className={styles.column}
        onClick={click}
        onPointerOver={view.onMarks ? hover : undefined}
        onPointerOut={view.onMarks ? hover : undefined}
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
                    onClick={() =>
                      viewRef.current.onSeekTime?.(unit.time!.startMs)
                    }
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
