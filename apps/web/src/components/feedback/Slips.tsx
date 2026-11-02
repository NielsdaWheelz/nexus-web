"use client";

/** The stage's one presentation: a frame per anchor, portaled into it, with the same anatomy in
 * every room. It renders what `stage.ts` decided and reports what the hand did; it decides
 * nothing about where or when. A frame is a labelled region after its anchor's content in tab
 * order, so it is reachable without ever taking focus. Only the topmost room speaks. */
import { ChevronDown, X } from "lucide-react";
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import Button from "@/components/ui/Button";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { matchesShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { OverlayContext, topModal } from "@/lib/ui/overlay";
import { VerbControl } from "./Fact";
import { Announcement } from "./Feedback";
import { useStage, type Anchor, type RoomView, type SlipView, type Speech } from "./stage";
import styles from "./Slips.module.css";

const SWIPE_STARTS_PX = 4;
const SWIPE_DISMISSES_PX = 32;
const SWIPE_DISMISSES_PX_PER_MS = 0.11;
const SWIPE_UPWARD_FRICTION = 0.3;

/** Withdrawal restores only owned focus: what `owner` held passes to `target`, unless a command
 * already handed it elsewhere, or a modal now owns it. */
function useFocusReturn(owner: RefObject<HTMLElement | null>, target: () => HTMLElement | null) {
  const latest = useRef(target);
  latest.current = target;
  useLayoutEffect(() => () => {
    const focused = document.activeElement;
    if (!owner.current?.contains(focused)) return;
    queueMicrotask(() => {
      const current = document.activeElement;
      if (current !== focused && current !== document.body && current?.isConnected) return;
      const next = latest.current();
      const modal = topModal();
      if (!next?.isConnected || next.closest("[hidden], [inert]") || modal && !modal.element?.contains(next)) return;
      next.focus({ preventScroll: true });
    });
  }, [owner]);
}

const ROOT: Anchor = { kind: "Root" };
/** Every row carries a control, so a frame is reached through its first one. */
const firstControl = (room: HTMLElement | null) => room?.querySelector<HTMLElement>("button, a") ?? null;

function useRoom(anchor: Anchor) {
  const stage = useStage();
  const element = useRef<HTMLDivElement>(null);
  // justify-type-assertion: the anchor's own element, committed before this layout effect.
  useLayoutEffect(() => stage.anchor(anchor, element.current!), [stage, anchor]);
  return element;
}

function RootAnchor() {
  return <div ref={useRoom(ROOT)} className={styles.anchor} />;
}

/** Its floor can stand above the viewport's, so what covers it is projected onto it. */
function PaneAnchor({ paneId }: { paneId: string }) {
  const element = useRoom(useMemo(() => ({ kind: "Pane", paneId }), [paneId]));
  const viewport = useMobileViewport();
  // justify-type-assertion: the anchor's own element, committed before this layout effect.
  useLayoutEffect(() => viewport.registerStageAnchor(element.current!), [viewport, element]);
  return <div ref={element} className={styles.anchor} />;
}

function ModalAnchor() {
  const layer = useContext(OverlayContext);
  if (!layer) throw new Error("a modal stage anchor requires its ModalFrame");
  const element = useRoom(useMemo(() => ({ kind: "Modal", layer }), [layer]));
  return <div ref={element} className={`${styles.anchor} ${styles.modalAnchor}`} />;
}

/** Where slips land. Root is the host's root element, Pane sits above its content (a pane's
 * latest wins, so a composer takes over while it stands), Modal sits in its panel. */
export function StageAnchor(props: { kind: "Root" } | { kind: "Pane"; paneId: string } | { kind: "Modal" }) {
  switch (props.kind) {
    case "Root": return <RootAnchor />;
    case "Pane": return <PaneAnchor paneId={props.paneId} />;
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
      target.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", reach);
    return () => document.removeEventListener("keydown", reach);
  }, [stage, platform]);
  return view.rooms.map(room => createPortal(<Room room={room} typing={view.typing} speech={view.speech} />, room.element, String(room.id)));
}

type Return = {
  frame: RefObject<HTMLElement | null>;
  /** Where focus came from when it entered the frame. */
  origin: RefObject<HTMLElement | null>;
  /** A verb that navigated took focus with it. */
  navigated: RefObject<boolean>;
  target(): HTMLElement | null;
};

function Room({ room, typing, speech }: { room: RoomView; typing: boolean; speech: Speech }) {
  const frame = useRef<HTMLElement>(null);
  const origin = useRef<HTMLElement>(null);
  const navigated = useRef(false);
  const target = () => navigated.current ? null
    : origin.current?.isConnected ? origin.current
    : room.element.closest<HTMLElement>("[data-pane-focus-landmark], [role='dialog']");
  const focus = { frame, origin, navigated, target };
  const polite = room.speaks ? speech.Polite : null;
  const assertive = room.speaks ? speech.Assertive : null;
  return <>
    {room.anchor.kind === "Pane" ? null : <>
      <Announcement text={polite?.text ?? ""} level="Polite" occurrence={polite?.occurrence} />
      <Announcement text={assertive?.text ?? ""} level="Assertive" occurrence={assertive?.occurrence} />
    </>}
    {room.slips.length > 0 ? <Frame room={room} typing={typing} focus={focus} /> : null}
    {room.tucked.length > 0 ? <Tab room={room} focus={focus} /> : null}
  </>;
}

function Frame({ room, typing, focus }: { room: RoomView; typing: boolean; focus: Return }) {
  const stage = useStage();
  const { frame } = focus;
  const [onset, setOnset] = useState<"Risk" | "Notice" | null>(room.slips.some(({ row }) => row.weight === "Risk") ? "Risk" : "Notice");
  const standing = useRef(false);
  const swipe = useRef<{ pointer: number; startY: number; y: number; at: number; speed: number } | null>(null);
  useFocusReturn(frame, focus.target);
  // Nothing changes under a hold: a row stacking in cannot widen the frame beneath a pointer.
  useLayoutEffect(() => {
    const element = frame.current;
    if (element) element.style.inlineSize = room.held ? `${element.getBoundingClientRect().width}px` : "";
  }, [frame, room.held]);
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
  const follow = (offset: number | null) => {
    const element = frame.current;
    if (!element) return;
    element.toggleAttribute("data-dragging", offset !== null);
    element.style.transform = offset === null || matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : `translateY(${offset}px)`;
  };
  const leaving = room.slips.some(slip => slip.leaving === null) ? null : room.slips[0].leaving;
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
    onPointerDown={event => {
      stage.holdRoom(room.id, "Press", true);
      if (event.pointerType === "touch") swipe.current = { pointer: event.pointerId, startY: event.clientY, y: event.clientY, at: event.timeStamp, speed: 0 };
    }}
    onPointerMove={event => {
      const drag = swipe.current;
      if (drag?.pointer !== event.pointerId) return;
      drag.speed = (event.clientY - drag.y) / Math.max(1, event.timeStamp - drag.at);
      drag.y = event.clientY;
      drag.at = event.timeStamp;
      const offset = drag.y - drag.startY;
      if (Math.abs(offset) >= SWIPE_STARTS_PX) follow(offset < 0 ? offset * SWIPE_UPWARD_FRICTION : offset);
    }}
    onPointerUp={event => {
      const drag = swipe.current;
      if (drag?.pointer !== event.pointerId) return;
      swipe.current = null;
      follow(null);
      const offset = drag.y - drag.startY;
      if (offset >= SWIPE_STARTS_PX && (offset > SWIPE_DISMISSES_PX || drag.speed >= SWIPE_DISMISSES_PX_PER_MS)) stage.sweep(room.id);
    }}
    onPointerCancel={() => { swipe.current = null; follow(null); }}
    onFocus={event => {
      stage.holdRoom(room.id, "Focus", true);
      const from = event.relatedTarget;
      if (from instanceof Node && event.currentTarget.contains(from)) return;
      focus.origin.current = from instanceof HTMLElement ? from : null;
      focus.navigated.current = false;
    }}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) stage.holdRoom(room.id, "Focus", false);
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

function Slip({ slip, stacked, frameLeaving, focus }: { slip: SlipView; stacked: boolean; frameLeaving: boolean; focus: Return }) {
  const stage = useStage();
  const { row, leaving } = slip;
  const element = useRef<HTMLDivElement>(null);
  const lineId = useId();
  const [outgoing, setOutgoing] = useState(slip.replaced);
  const [onset, setOnset] = useState(stacked && outgoing === null ? row.weight === "Risk" ? "Risk" : "Notice" : undefined);
  useFocusReturn(element, () => firstControl(focus.frame.current) ?? focus.target());
  const plain = row.weight === "Plain";
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
    {row.verbs?.map(verb => <VerbControl key={verb.label} verb={verb} contextId={lineId} onActivated={() => {
      focus.navigated.current = "href" in verb;
      if (plain) stage.close(row.key);
    }} />)}
    {plain
      ? <Button className={styles.close} iconOnly icon={<X />} aria-label="close notice" onClick={() => stage.close(row.key)} />
      : <Button className={styles.close} iconOnly icon={<ChevronDown />} aria-label="tuck notice" onClick={() => stage.tuck(row.key)} />}
  </div>;
}

/** Tucked rows on the anchor's edge: reachable until their owners resolve, retaining nothing. */
function Tab({ room, focus }: { room: RoomView; focus: Return }) {
  const stage = useStage();
  const element = useRef<HTMLButtonElement>(null);
  const count = room.tucked.length;
  useFocusReturn(element, () => firstControl(focus.frame.current) ?? focus.target());
  return <button
    ref={element}
    type="button"
    className={styles.tab}
    data-weight={room.tucked.some(row => row.weight === "Risk") ? "Risk" : "Held"}
    aria-label={count > 1 ? `show ${count} notices` : "show notice"}
    onClick={() => stage.restore(room.id)}
  >{count > 1 ? <span aria-hidden="true">{count}</span> : null}</button>;
}
