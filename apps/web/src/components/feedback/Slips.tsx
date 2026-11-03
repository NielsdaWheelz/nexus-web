"use client";

/** The stage's one presentation: a frame per anchor, portaled into it, with the same anatomy in
 * every room. It renders what `stage.ts` decided and reports what the hand did; it decides
 * nothing about where or when. A frame is a labelled region after its anchor's content in tab
 * order, so it is reachable without ever taking focus. Only the topmost room speaks. */
import { ChevronDown, X } from "lucide-react";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FocusEvent, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { OverlayContext } from "@/lib/ui/overlay";
import { findActivePaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { takeFocus, useFocusReturn, VerbControl } from "./Fact";
import { Announcement } from "./Feedback";
import { useStage, type Anchor, type RoomView, type SlipView, type Speech, type Verb } from "./stage";
import styles from "./Slips.module.css";

const SWIPE_STARTS_PX = 4;
const SWIPE_DISMISSES_PX = 32;
const SWIPE_DISMISSES_PX_PER_MS = 0.11;
/** Speed is the hand's over this span before the lift, so a finger that stopped reads still and
 * one quick sample is no flick. */
const SWIPE_SPEED_SPAN_MS = 100;
const SWIPE_UPWARD_FRICTION = 0.3;

/** The frame on the finger, or back in place. */
function follow(element: HTMLElement | null, offset: number | null) {
  if (!element) return;
  element.toggleAttribute("data-dragging", offset !== null);
  element.style.transform = offset === null || matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : `translateY(${offset}px)`;
}

/** Touch only. The frame follows the finger on `transform`; down past the line, or fast enough
 * as it lifts, `sweep` takes it from where it was let go. Everything else settles it back. */
function useSwipe(frame: RefObject<HTMLElement | null>, leaving: boolean, sweep: () => void) {
  const drag = useRef<{ pointer: number; startY: number; y: number; trail: { y: number; at: number }[] } | null>(null);
  // A frame that stops leaving outlived its sweep, so it stands back where it belongs.
  useLayoutEffect(() => { if (!leaving) follow(frame.current, null); }, [frame, leaving]);
  return {
    onPointerDown(event: PointerEvent) {
      if (event.pointerType === "touch") drag.current = { pointer: event.pointerId, startY: event.clientY, y: event.clientY, trail: [{ y: event.clientY, at: event.timeStamp }] };
    },
    onPointerMove(event: PointerEvent) {
      const current = drag.current;
      if (current?.pointer !== event.pointerId) return;
      current.y = event.clientY;
      current.trail.push({ y: event.clientY, at: event.timeStamp });
      const offset = current.y - current.startY;
      if (Math.abs(offset) >= SWIPE_STARTS_PX) follow(frame.current, offset < 0 ? offset * SWIPE_UPWARD_FRICTION : offset);
    },
    onPointerUp(event: PointerEvent) {
      const current = drag.current;
      if (current?.pointer !== event.pointerId) return;
      drag.current = null;
      const offset = current.y - current.startY;
      const from = current.trail.findLast(({ at }) => at <= event.timeStamp - SWIPE_SPEED_SPAN_MS) ?? current.trail[0];
      const speed = (current.y - from.y) / Math.max(1, event.timeStamp - from.at);
      if (offset >= SWIPE_STARTS_PX && (offset > SWIPE_DISMISSES_PX || speed >= SWIPE_DISMISSES_PX_PER_MS)) sweep();
      else follow(frame.current, null);
    },
    onPointerCancel() {
      drag.current = null;
      follow(frame.current, null);
    },
  };
}

const ROOT: Anchor = { kind: "Root" };
/** A hint would take the frame's first Escape. */
const NO_HINT = { text: "" };
/** Every row carries a control, so a frame is reached through its first one. */
const firstControl = (room: HTMLElement | null) => room?.querySelector<HTMLElement>("button, a") ?? null;

function useRoom(anchor: Anchor, floor = false) {
  const stage = useStage();
  const element = useRef<HTMLDivElement>(null);
  // justify-type-assertion: the anchor's own element, committed before this layout effect.
  useLayoutEffect(() => stage.anchor(anchor, element.current!, floor), [stage, anchor, floor]);
  return element;
}

/** An anchor's floor can stand above the viewport's, so what covers it is projected onto it. */
function useProjection(element: RefObject<HTMLElement | null>) {
  const viewport = useMobileViewport();
  // justify-type-assertion: the anchor's own element, committed before this layout effect.
  useLayoutEffect(() => viewport.registerStageAnchor(element.current!), [viewport, element]);
}

function RootAnchor() {
  const element = useRoom(ROOT);
  useProjection(element);
  return <div ref={element} className={styles.anchor} />;
}

function PaneAnchor({ paneId, floor }: { paneId: string; floor?: true }) {
  const element = useRoom(useMemo(() => ({ kind: "Pane", paneId }), [paneId]), floor);
  useProjection(element);
  return <div ref={element} className={styles.anchor} />;
}

function ModalAnchor() {
  const layer = useContext(OverlayContext);
  if (!layer) throw new Error("a modal stage anchor requires its ModalFrame");
  const element = useRoom(useMemo(() => ({ kind: "Modal", layer }), [layer]));
  return <div ref={element} className={`${styles.anchor} ${styles.modalAnchor}`} />;
}

/** Where slips land. Root is the canvas, or a host's root element, which keeps tabindex -1 to take
 * focus back from a frame whose origin is gone. Modal sits in its panel. Pane sits above its
 * content: `floor` is the shell's own, and any composer's stands over it while it stands, the
 * latest of them winning. A composer's is a zero-height box at its top edge, outside any clip. */
export function StageAnchor(props: { kind: "Root" } | { kind: "Pane"; paneId: string; floor?: true } | { kind: "Modal" }) {
  switch (props.kind) {
    case "Root": return <RootAnchor />;
    case "Pane": return <PaneAnchor paneId={props.paneId} floor={props.floor} />;
    case "Modal": return <ModalAnchor />;
  }
}

export default function Slips() {
  const stage = useStage();
  const view = useSyncExternalStore(stage.subscribe, stage.snapshot, stage.snapshot);
  const { platform } = useRenderEnvironment();
  useEffect(() => {
    const reach = (event: KeyboardEvent) => {
      if (!matchesShortcut(SHORTCUTS["Stage.Reach"], event, platform)) return;
      const target = firstControl(stage.reachable());
      if (!target) return;
      event.preventDefault();
      takeFocus(target);
    };
    document.addEventListener("keydown", reach);
    return () => document.removeEventListener("keydown", reach);
  }, [stage, platform]);
  // Root and pane rooms share a floor and root paints later, so a root room stands clear of all
  // that pane rooms show. A held room stays put, and rises when the hold ends.
  useLayoutEffect(() => {
    const root = view.rooms.findLast(({ anchor }) => anchor.kind === "Root");
    if (!root || root.held) return;
    const tops = view.rooms.flatMap(({ anchor, element }) => anchor.kind === "Pane" ? [...element.children].map(child => child.getBoundingClientRect().top) : []);
    const clearance = tops.length > 0 ? root.element.getBoundingClientRect().bottom - Math.min(...tops) : 0;
    root.element.style.setProperty("--stage-pane-clearance", `${clearance}px`);
  }, [view]);
  return view.rooms.map(room => createPortal(<Room room={room} typing={view.typing} speech={view.speech} />, room.element, String(room.id)));
}

type FocusHome = {
  frame: RefObject<HTMLElement | null>;
  /** A verb that navigated took focus with it. */
  navigated: RefObject<boolean>;
  /** Where focus goes when the room gives it up. */
  target(): HTMLElement | null;
  /** Where focus goes when one of the room's own controls withdraws. */
  stay(): HTMLElement | null;
  /** Focus arrived on a frame or a tab; from outside the room, that is where it came from. */
  entered(event: FocusEvent): void;
  /** Focus left a frame or a tab. */
  left(event: FocusEvent): void;
  /** Focus moves between the room's own controls, so its origin stands, whatever the event says. */
  pass(next: HTMLElement): void;
};

function Room({ room, typing, speech }: { room: RoomView; typing: boolean; speech: Speech }) {
  const stage = useStage();
  const frame = useRef<HTMLElement>(null);
  const origin = useRef<HTMLElement>(null);
  const navigated = useRef(false);
  /** The control the window went away from, which stays the document's focus meanwhile. */
  const away = useRef<EventTarget>(null);
  const target = () => navigated.current ? null
    : origin.current?.isConnected ? origin.current
    : room.anchor.kind === "Root" ? findActivePaneLandmarkFocusTarget() ?? room.element.closest<HTMLElement>("[tabindex='-1']")
    : room.element.closest<HTMLElement>("[data-pane-focus-landmark], [role='dialog']");
  const focus: FocusHome = {
    frame,
    navigated,
    target,
    stay: () => firstControl(frame.current) ?? target(),
    entered({ target: control, relatedTarget: from }) {
      // The window came back to where it left: focus never left the room, so its origin stands.
      const returned = from === null && control === away.current;
      away.current = null;
      if (returned || from instanceof Node && room.element.contains(from)) return;
      origin.current = from instanceof HTMLElement ? from : null;
      navigated.current = false;
    },
    left({ target: control, relatedTarget: to }) {
      away.current = to === null && document.activeElement === control ? control : null;
    },
    pass(next) {
      const from = origin.current;
      takeFocus(next);
      origin.current = from;
    },
  };
  const polite = room.speaks ? speech.Polite : null;
  const assertive = room.speaks ? speech.Assertive : null;
  return <>
    {room.anchor.kind === "Pane" ? null : <>
      <Announcement text={polite?.text ?? ""} level="Polite" occurrence={polite?.occurrence} onPublish={() => stage.delivered("Polite")} />
      <Announcement text={assertive?.text ?? ""} level="Assertive" occurrence={assertive?.occurrence} onPublish={() => stage.delivered("Assertive")} />
    </>}
    {room.slips.length > 0 ? <Frame room={room} typing={typing} focus={focus} /> : null}
    {room.tucked.length > 0 ? <Tab room={room} focus={focus} /> : null}
  </>;
}

function Frame({ room, typing, focus }: { room: RoomView; typing: boolean; focus: FocusHome }) {
  const stage = useStage();
  const { frame } = focus;
  const [onset, setOnset] = useState<"Risk" | "Notice" | null>(room.slips.some(({ row }) => row.weight === "Risk") ? "Risk" : "Notice");
  const standing = useRef(false);
  const end = useRef<HTMLElement>(null);
  useFocusReturn(frame, focus.target);
  // Nothing changes under a hold: a row stacking in cannot widen the frame beneath a pointer.
  useLayoutEffect(() => {
    const element = frame.current;
    if (element) element.style.inlineSize = room.held ? `${element.getBoundingClientRect().width}px` : "";
  }, [frame, room.held]);
  // Three rows, then internal scroll. The frame ends at the third, and a hold keeps that row: what
  // lands grows the frame above the rows that stand, and the cap returns when the hold ends.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const third = element.children[2];
    if (!room.held || !end.current?.isConnected) end.current = third instanceof HTMLElement ? third : null;
    element.style.maxBlockSize = element.children.length > 3 && end.current
      ? `min(${end.current.offsetTop + end.current.offsetHeight + 2 * element.clientTop}px, var(--stage-ceiling) - 24px)` : "";
  }, [frame, room.slips, room.held]);
  useEffect(() => {
    standing.current = true;
    const release = () => stage.holdRoom(room.id, "Press", false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      stage.releaseRoom(room.id);
    };
  }, [stage, room.id]);
  const leaving = room.slips.some(slip => slip.leaving === null) ? null : room.slips[0].leaving;
  const swipe = useSwipe(frame, leaving !== null, () => stage.sweep(room.id));
  return <section
    ref={frame}
    className={styles.frame}
    aria-label="notices"
    data-onset={onset ?? undefined}
    data-leaving={leaving ?? undefined}
    data-typing={typing || undefined}
    data-risk={room.slips.some(({ row }) => row.weight === "Risk") || undefined}
    data-many={room.slips.length > 3 || undefined}
    onAnimationEnd={event => {
      if (event.target !== event.currentTarget) return;
      setOnset(null);
      if (leaving) for (const { row } of room.slips) stage.gone(row.key);
    }}
    onPointerEnter={event => { if (event.pointerType === "mouse") stage.holdRoom(room.id, "Pointer", true); }}
    onPointerLeave={() => stage.holdRoom(room.id, "Pointer", false)}
    {...swipe}
    onPointerDown={event => {
      stage.holdRoom(room.id, "Press", true);
      swipe.onPointerDown(event);
    }}
    onFocus={event => {
      stage.holdRoom(room.id, "Focus", true);
      focus.entered(event);
    }}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) stage.holdRoom(room.id, "Focus", false);
      focus.left(event);
    }}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      stage.sweep(room.id);
    }}
  >
    {room.slips.toReversed().map(slip => <Slip key={slip.id} slip={slip} stacked={standing.current} frameLeaving={leaving !== null} focus={focus} />)}
  </section>;
}

function Slip({ slip, stacked, frameLeaving, focus }: { slip: SlipView; stacked: boolean; frameLeaving: boolean; focus: FocusHome }) {
  const stage = useStage();
  const { row, leaving } = slip;
  const element = useRef<HTMLDivElement>(null);
  const lineId = useId();
  const [outgoing, setOutgoing] = useState(slip.replaced);
  const [onset, setOnset] = useState(stacked && outgoing === null ? row.weight === "Risk" ? "Risk" : "Notice" : undefined);
  useFocusReturn(element, focus.stay, focus.pass);
  const withdrawal = { target: focus.stay, give: focus.pass };
  const plain = row.weight === "Plain";
  const activated = (verb: Verb) => () => {
    focus.navigated.current = "href" in verb;
    if (plain) stage.dismiss(row.key);
  };
  return <div
    ref={element}
    className={styles.row}
    data-weight={row.weight}
    data-onset={onset}
    data-leaving={frameLeaving ? undefined : leaving ?? undefined}
    onAnimationEnd={event => {
      if (event.target !== event.currentTarget) return;
      setOnset(undefined);
      if (leaving) stage.gone(row.key);
    }}
  >
    <p id={lineId} className={styles.line}>
      {outgoing ? <span className={styles.outgoing} aria-hidden="true" onAnimationEnd={() => setOutgoing(null)}>
        <span className={styles.fact}>{outgoing.fact}</span>{outgoing.reason ? <span className={styles.reason}> {outgoing.reason}</span> : null}
      </span> : null}
      <span data-incoming={slip.replaced ? true : undefined} className={styles.text}>
        <span className={styles.fact}>{row.line.fact}</span>{row.line.reason ? <span className={styles.reason}> {row.line.reason}</span> : null}
      </span>
    </p>
    {row.verbs ? <VerbControl verb={row.verbs[0]} contextId={lineId} onActivated={activated(row.verbs[0])} withdrawal={withdrawal} /> : null}
    {row.verbs?.[1] ? <VerbControl verb={row.verbs[1]} contextId={lineId} onActivated={activated(row.verbs[1])} withdrawal={withdrawal} /> : null}
    {plain
      ? <Button className={styles.close} iconOnly icon={<X />} aria-label="close notice" tooltip={NO_HINT} onClick={() => stage.dismiss(row.key)} />
      : <Button className={styles.close} iconOnly icon={<ChevronDown />} aria-label="tuck notice" tooltip={NO_HINT} onClick={() => stage.tuck(row.key)} />}
  </div>;
}

/** Tucked rows on the anchor's edge: reachable until their owners resolve, retaining nothing. */
function Tab({ room, focus }: { room: RoomView; focus: FocusHome }) {
  const stage = useStage();
  const element = useRef<HTMLButtonElement>(null);
  const count = room.tucked.length;
  useFocusReturn(element, focus.stay, focus.pass);
  return <button
    ref={element}
    type="button"
    className={styles.tab}
    data-weight={room.tucked.some(row => row.weight === "Risk") ? "Risk" : "Held"}
    aria-label={count > 1 ? `show ${count} notices` : "show notice"}
    onFocus={focus.entered}
    onBlur={focus.left}
    onClick={() => stage.restore(room.id)}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const target = focus.target();
      if (target) takeFocus(target);
    }}
  >{count > 1 ? <span aria-hidden="true">{count}</span> : null}</button>;
}
