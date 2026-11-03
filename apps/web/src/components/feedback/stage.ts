/** The session's one stage. A row is a fact an owner raised; the stage decides where and when
 * it stands. Rows live here, above every pane, because their owners do; each carries the address
 * it was raised from. `anchorOf` is the whole of placement. Every change passes through `settle`,
 * so succession, clocks and speech cannot disagree with where a row stands.
 *
 * Invariants: appearance never takes focus. A clock runs only while its row is displayed, unheld,
 * not typing and the document visible. Only Plain rows expire; a Held row tucks itself; Held and
 * Risk leave only when their owner does. Dismissal changes presentation, never the owner's work.
 * Rows that have stood keep their places: a frame reads in landing order, not raise order, so a
 * late row lifts nothing. Only a row's first showing replaces, and only the plain row directly
 * beneath it, once that row has stood there. Rows that land together stack. A line
 * is heard once: a region keeps what it carried, and the next room takes only what none has. */
import { createContext, useContext, useLayoutEffect } from "react";
import { TRANSPORT_LINES, type Transport } from "@/lib/api/failure";
import { updateRemedy } from "@/lib/native/admission";
import type { TargetLinkActivationResult } from "@/lib/panes/targetLinkActivation";
import { isTextEntryTarget } from "@/lib/ui/eventTarget";
import { onOverlayStack, subscribeOverlayStack, topModal, type Layer } from "@/lib/ui/overlay";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";

export type Address = { kind: "Pane"; paneId: string } | { kind: "Workspace" };
export type Line = { fact: string; reason?: string };
export type LinkActivation = (event: TargetActivationEvent) => TargetLinkActivationResult;
export type CommandVerb = { label: string; commandKey: string; run(intent: OpenIntent): void; busy?: boolean; disabledReason?: string; copied?: object };
export type LinkVerb = { label: string; href: string; target?: "_blank"; onActivate?: LinkActivation; busy?: boolean; disabledReason?: string };
export type Verb = CommandVerb | LinkVerb;
export type Verbs = readonly [Verb] | readonly [Verb, Verb];
export type Weight = "Plain" | "Held" | "Risk";
export type Row = {
  /** A held row's is its owner's `id`, so a new owner of that id takes the row over; a said
   * row's is its own. */
  key: object | string; address: Address; modal: Layer | null;
  weight: Weight; line: Line; verbs: Verbs | null;
  /** Keys speech. */
  attempt: number;
  /** Held and Risk only. */
  tucked: boolean;
};
export type Anchor = { kind: "Root" } | { kind: "Pane"; paneId: string } | { kind: "Modal"; layer: Layer };
export type World = {
  /** The topmost open modal. */
  modal: Layer | null;
  /** Panes fully in view. */
  inView: ReadonlySet<string>;
  /** Panes with a registered anchor. */
  panes: ReadonlySet<string>;
  active: string | null;
  /** Phone or maximized. */
  single: boolean;
};
export type Retract = () => void;
export type Shell = { signIn: Verb | null };
/** A mounted holder of an id, where it renders now. */
export type Owner = { address: Address };
export type HoldKind = "Pointer" | "Focus" | "Press";
export type Leaving = "Expired" | "Dismissed" | "Tucking";

export function anchorOf(row: Row, world: World): Anchor | null {
  if (world.modal) return row.weight === "Risk" || row.modal === world.modal
    ? { kind: "Modal", layer: world.modal } : null;           // null: wait, clock stopped
  const paneId = world.single ? world.active
    : row.address.kind === "Pane" && world.inView.has(row.address.paneId) ? row.address.paneId : null;
  return paneId !== null && world.panes.has(paneId) ? { kind: "Pane", paneId } : { kind: "Root" };
}

const RELOAD: Verb = { label: "reload", commandKey: "Reload", run: () => window.location.reload() };

/** A transport's verb. `retry` is the owner's; `Update` reloads only where reload can work. */
export function transportVerbs(transport: Transport, { retry, signIn }: { retry?: Verb; signIn: Verb | null }): Verbs | null {
  const kind = TRANSPORT_LINES[transport].verb;
  switch (kind) {
    case null: return null;
    case "Retry": return retry ? [retry] : null;
    case "SignIn": return signIn ? [signIn] : null;
    case "Update": return updateRemedy() === "Reload" ? [RELOAD] : null;
  }
}

const PLAIN_MS = 5000;
const VERB_MS = 8000;
const HELD_MS = 8000;
const TYPING_PAUSE_MS = 1200;
const TYPING_WAIT_MS = 8000;

type Clock = { remaining: number; running: { since: number; timer: ReturnType<typeof setTimeout> } | null };
type Room = { id: number; anchor: Anchor; element: HTMLElement; holds: Set<HoldKind> };
type Slip = {
  id: number;
  row: Row;
  raised: number;
  room: Room | null;
  /** Once true, typing no longer holds it back. */
  shown: boolean;
  leaving: Leaving | null;
  clock: Clock | null;
  /** The line this row replaced in its frame, for the crossfade. */
  replaced: Line | null;
  /** The attempt last sent to speech. */
  spoken: number | null;
};
type Said = { text: string; occurrence: object };
export type Speech = { Polite: Said | null; Assertive: Said | null };
export type SlipView = { id: number; row: Row; leaving: Leaving | null; replaced: Line | null };
export type RoomView = { id: number; anchor: Anchor; element: HTMLElement; slips: readonly SlipView[]; tucked: readonly Row[]; held: boolean; speaks: boolean };
export type StageView = { rooms: readonly RoomView[]; typing: boolean; speech: Speech };

function lifetime({ weight, verbs }: Row): number | null {
  switch (weight) {
    case "Plain": return verbs ? VERB_MS : PLAIN_MS;
    case "Held": return HELD_MS;
    case "Risk": return null;
  }
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
  switch (a.kind) {
    case "Root": return b.kind === "Root";
    case "Pane": return b.kind === "Pane" && b.paneId === a.paneId;
    case "Modal": return b.kind === "Modal" && b.layer === a.layer;
  }
}

const sameAddress = (a: Address, b: Address) => a.kind === "Pane" ? b.kind === "Pane" && a.paneId === b.paneId : b.kind === "Workspace";
export const sentence = ({ fact, reason }: Line) => reason ? `${fact} ${reason}` : fact;

function stopClock(clock: Clock | null): void {
  if (clock?.running == null) return;
  clearTimeout(clock.running.timer);
  clock.remaining = Math.max(0, clock.remaining - (performance.now() - clock.running.since));
  clock.running = null;
}

export function createStage() {
  const rooms: Room[] = [];
  const listeners = new Set<() => void>();
  let slips: Slip[] = [];
  let workspace: { inView: ReadonlySet<string>; active: string | null; single: boolean } = { inView: new Set(), active: null, single: false };
  let modal: Layer | null = null;
  let typing: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  let nextRoom = 0;
  let nextSlip = 0;
  let speech: Speech = { Polite: null, Assertive: null };
  /** What no live region has carried: a new occurrence cancels the one before it, so it takes these on. */
  const unsaid: Record<keyof Speech, Set<string>> = { Polite: new Set(), Assertive: new Set() };
  let speaker: Room | null = null;
  let view: StageView = { rooms: [], typing: false, speech };
  /** Mounted owners per held id, earliest first. */
  const owners = new Map<string, Owner[]>();

  const roomOf = (anchor: Anchor) => rooms.findLast(room => sameAnchor(room.anchor, anchor)) ?? null;
  const renewClock = (slip: Slip) => {
    stopClock(slip.clock);
    const remaining = lifetime(slip.row);
    slip.clock = remaining === null ? null : { remaining, running: null };
  };
  /** Past an exit that has not ended: the row stands again with its whole life. */
  const revive = (slip: Slip) => {
    slip.leaving = null;
    renewClock(slip);
  };
  /** Into a frame from outside it: on top of whatever stands, whenever it was raised. */
  const land = (slip: Slip) => {
    slips = [...slips.filter(other => other !== slip), slip];
  };
  const remove = (slip: Slip) => {
    stopClock(slip.clock);
    slips = slips.filter(other => other !== slip);
  };
  const expire = (slip: Slip) => {
    slip.clock = null;
    leave(slip, slip.row.weight === "Plain" ? "Expired" : "Tucking");
  };
  const conclude = (slip: Slip) => {
    if (slip.leaving === "Tucking") {
      slip.row = { ...slip.row, tucked: true };
      slip.leaving = null;
    } else remove(slip);
  };

  function settle(): void {
    modal = topModal();
    const world: World = { modal, ...workspace, panes: new Set(rooms.flatMap(({ anchor }) => anchor.kind === "Pane" ? [anchor.paneId] : [])) };
    const arrived = new Set<Slip>();
    const stood = new Set<Slip>();
    for (const slip of slips) {
      const anchor = anchorOf(slip.row, world);
      const room = anchor === null ? null : roomOf(anchor);
      const yields = !slip.shown && typing !== null && slip.row.weight !== "Risk" && performance.now() - slip.raised < TYPING_WAIT_MS;
      const next = yields ? null : room;
      if (next !== null && !slip.shown) arrived.add(slip);
      if (next !== null && next === slip.room) stood.add(slip); else slip.replaced = null;
      slip.room = next;
      slip.shown ||= next !== null;
    }
    for (const slip of arrived) land(slip);
    // An exit needs a frame to play in; without one it ends here, or the row would outlive it.
    for (const slip of slips.filter(slip => slip.leaving !== null && slip.room === null)) conclude(slip);
    // Landing order, so `under` is the row directly beneath in its frame. A tucked row is in no frame.
    const beneath = new Map<Room, Slip>();
    for (const slip of slips) {
      if (slip.room === null || slip.row.tucked) continue;
      const under = beneath.get(slip.room);
      if (under?.row.weight === "Plain" && stood.has(under) && slip.row.weight === "Plain" && arrived.has(slip) && slip.room.holds.size === 0) {
        remove(under);
        slip.replaced = under.row.line;
      }
      beneath.set(slip.room, slip);
    }
    for (const slip of slips) {
      const clock = slip.clock;
      if (clock === null) continue;
      const runs = connected && slip.room !== null && slip.leaving === null && !slip.row.tucked
        && slip.room.holds.size === 0 && typing === null && !document.hidden;
      if (!runs) stopClock(clock);
      else if (clock.running === null)
        clock.running = { since: performance.now(), timer: setTimeout(() => expire(slip), clock.remaining) };
    }
    for (const slip of slips) {
      if (slip.room === null || slip.spoken === slip.row.attempt) continue;
      slip.spoken = slip.row.attempt;
      const level = slip.row.weight === "Risk" ? "Assertive" : "Polite";
      unsaid[level].add(sentence(slip.row.line));
      speech = { ...speech, [level]: { text: [...unsaid[level]].join(" "), occurrence: {} } };
    }
    const voice = roomOf(modal ? { kind: "Modal", layer: modal } : { kind: "Root" });
    if (voice !== speaker) {
      speaker = voice;
      speech = { Polite: unsaid.Polite.size > 0 ? speech.Polite : null, Assertive: unsaid.Assertive.size > 0 ? speech.Assertive : null };
    }
    view = {
      typing: typing !== null,
      speech,
      rooms: rooms.flatMap(room => {
        const here = slips.filter(slip => slip.room === room);
        const shown = here.filter(slip => !slip.row.tucked);
        const tucked = here.filter(slip => slip.row.tucked);
        if (room.anchor.kind === "Pane" && here.length === 0) return [];
        return [{
          id: room.id, anchor: room.anchor, element: room.element, held: room.holds.size > 0, speaks: room === speaker,
          slips: shown.map(({ id, row, leaving, replaced }) => ({ id, row, leaving, replaced })),
          tucked: tucked.map(slip => slip.row),
        }];
      }),
    };
    for (const listener of listeners) listener();
  }

  function leave(slip: Slip, how: Leaving): void {
    // The owner has resolved: a tuck would stand its row again with nothing left to end it.
    if (slip.leaving === "Dismissed" && how === "Tucking") return;
    slip.leaving = how;
    if (slip.row.tucked) conclude(slip);
    settle();
  }
  const slipOf = (key: object | string) => slips.find(slip => slip.row.key === key);
  const pause = () => {
    if (typing === null) return;
    clearTimeout(typing);
    typing = null;
    settle();
  };
  const typed = () => {
    const began = typing === null;
    if (typing !== null) clearTimeout(typing);
    typing = setTimeout(pause, TYPING_PAUSE_MS);
    if (began || slips.some(slip => !slip.shown)) settle();
  };
  const raise = (fields: Omit<Row, "tucked">) => {
    const row: Row = { ...fields, tucked: false };
    const slip: Slip = { id: ++nextSlip, row, raised: performance.now(), room: null, shown: false, leaving: null, clock: null, replaced: null, spoken: null };
    renewClock(slip);
    slips = [...slips, slip];
    return slip;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => view,
    /** A plain row. The same fact from the same place restarts and speaks again. */
    say({ address, line, verbs }: { address: Address; line: Line; verbs: Verbs | null }): Retract {
      const raisedIn = topModal();
      const repeat = slips.find(({ row }) => row.weight === "Plain" && row.modal === raisedIn && sameAddress(row.address, address)
        && row.line.fact === line.fact && row.line.reason === line.reason);
      const slip = repeat ?? raise({ key: {}, address, modal: raisedIn, weight: "Plain", line, verbs, attempt: 0 });
      if (repeat) {
        repeat.row = { ...repeat.row, verbs, attempt: repeat.row.attempt + 1 };
        revive(repeat);
      }
      const { attempt } = slip.row;
      settle();
      return () => { if (slips.includes(slip) && slip.row.attempt === attempt) leave(slip, "Dismissed"); };
    },
    /** A mounted owner's row, keyed by its id, so tucking survives a new attempt and a new owner.
     * It stands at its earliest mounted owner's address, so owners of one id in two panes never
     * trade it. It belongs to the topmost modal at raise, unless `frame`, the modal the owner
     * renders inside, is mounting in the same commit and does not yet stand on the stack. An owner
     * that mounts with no other mounted places the row as a raise does, so a holder that moves
     * into a dialog takes its row there. Turning to risk presents and speaks whatever the row had
     * settled into. */
    hold({ key, owner, frame, risk, line, verbs, attempt }: Pick<Row, "line" | "verbs" | "attempt"> & { key: string; owner: Owner; frame: Layer | null; risk: boolean }): void {
      const earliest = owners.get(key)?.[0];
      const existing = slipOf(key);
      const { address } = earliest ?? owner;
      const modal = earliest && existing ? existing.row.modal : frame === null || onOverlayStack(frame) ? topModal() : frame;
      const weight = risk ? "Risk" : "Held";
      const slip = existing ?? raise({ key, address, modal, weight, line, verbs, attempt });
      const renewed = slip.row.attempt !== attempt || slip.row.weight !== weight;
      const atRisk = risk && slip.row.weight !== "Risk";
      if (atRisk && slip.row.tucked) land(slip);
      slip.row = { ...slip.row, address, modal, weight, line, verbs, attempt, tucked: slip.row.tucked && !atRisk };
      if (renewed) renewClock(slip);
      if (atRisk) slip.spoken = null;
      // An owner that comes back while its row is still leaving takes it back.
      if (slip.leaving === "Dismissed" || atRisk) slip.leaving = null;
      settle();
    },
    /** A close. */
    dismiss(key: object | string): void {
      const slip = slipOf(key);
      if (slip) leave(slip, "Dismissed");
    },
    /** A mounted owner of `id`. Its row passes to the next owner when the earliest leaves, keeping
     * its modal. It resolves as the commit its last owner left in ends with none mounted, so a
     * holder moving between parents keeps its row, tuck and speech, and a resolution or a changed
     * id leaves at once. */
    own(id: string, owner: Owner): Retract {
      const mounted = owners.get(id) ?? [];
      owners.set(id, mounted);
      mounted.push(owner);
      return () => {
        mounted.splice(mounted.indexOf(owner), 1);
        const [next] = mounted;
        if (next !== undefined) {
          const slip = slipOf(id);
          if (slip && !sameAddress(slip.row.address, next.address)) {
            slip.row = { ...slip.row, address: next.address };
            settle();
          }
          return;
        }
        // A commit runs its layout effects together, so an owner mounting in it has come by now.
        queueMicrotask(() => {
          if (owners.get(id) !== mounted || mounted.length > 0) return;
          owners.delete(id);
          const slip = slipOf(id);
          if (slip) leave(slip, "Dismissed");
        });
      };
    },
    tuck(key: object | string): void {
      const slip = slipOf(key);
      if (slip) leave(slip, "Tucking");
    },
    /** Esc and swipe: every row in the frame closes or tucks by its weight. */
    sweep(room: number): void {
      for (const slip of slips.filter(slip => slip.room?.id === room && !slip.row.tucked))
        leave(slip, slip.row.weight === "Plain" ? "Dismissed" : "Tucking");
    },
    restore(room: number): void {
      for (const slip of slips) {
        if (slip.room?.id !== room || !slip.row.tucked) continue;
        slip.row = { ...slip.row, tucked: false };
        renewClock(slip);
        land(slip);
      }
      settle();
    },
    /** The row's exit has played. */
    gone(key: object | string): void {
      const slip = slipOf(key);
      if (!slip?.leaving) return;
      conclude(slip);
      settle();
    },
    holdRoom(room: number, hold: HoldKind, held: boolean): void {
      const holds = rooms.find(({ id }) => id === room)?.holds;
      if (!holds || holds.has(hold) === held) return;
      if (held) holds.add(hold); else holds.delete(hold);
      // A hand that reaches a row in its fade holds it.
      if (held) for (const slip of slips) if (slip.room?.id === room && slip.leaving === "Expired") revive(slip);
      settle();
    },
    releaseRoom(room: number): void {
      const holds = rooms.find(({ id }) => id === room)?.holds;
      if (!holds || holds.size === 0) return;
      holds.clear();
      settle();
    },
    /** The last of an anchor's rooms wins, so a pane's floor goes first whichever effect ran first. */
    anchor(anchor: Anchor, element: HTMLElement, floor: boolean): () => void {
      const room: Room = { id: ++nextRoom, anchor, element, holds: new Set() };
      if (floor) rooms.unshift(room); else rooms.push(room);
      settle();
      return () => {
        rooms.splice(rooms.indexOf(room), 1);
        settle();
      };
    },
    workspace(next: typeof workspace): void {
      const moved = next.active !== workspace.active;
      workspace = next;
      if (moved) pause();
      settle();
    },
    /** A live region now carries everything it was given. */
    delivered(level: keyof Speech): void {
      unsaid[level].clear();
    },
    activePane: () => workspace.active,
    /** The room `mod+.` reaches: the modal's, then the active pane's, then any. */
    reachable(): HTMLElement | null {
      const standing = view.rooms.filter(room => room.slips.length > 0 || room.tucked.length > 0);
      const room = standing.find(({ anchor }) => anchor.kind === "Modal")
        ?? standing.find(({ anchor }) => anchor.kind === "Pane" && anchor.paneId === workspace.active)
        ?? standing[0];
      return room?.element ?? null;
    },
    connect(): () => void {
      const input = (event: Event) => { if (isTextEntryTarget(event.target)) typed(); };
      const blur = (event: Event) => { if (isTextEntryTarget(event.target)) pause(); };
      const overlays = () => { if (topModal() !== modal) settle(); };
      document.addEventListener("input", input, true);
      document.addEventListener("focusout", blur, true);
      document.addEventListener("visibilitychange", settle);
      const unsubscribe = subscribeOverlayStack(overlays);
      connected = true;
      settle();
      return () => {
        connected = false;
        document.removeEventListener("input", input, true);
        document.removeEventListener("focusout", blur, true);
        document.removeEventListener("visibilitychange", settle);
        unsubscribe();
        if (typing !== null) clearTimeout(typing);
        typing = null;
        for (const slip of slips) stopClock(slip.clock);
      };
    },
  };
}
export type Stage = ReturnType<typeof createStage>;

export const StageContext = createContext<Stage | null>(null);
export const ShellContext = createContext<Shell>({ signIn: null });

export function useStage(): Stage {
  const stage = useContext(StageContext);
  if (!stage) throw new Error("the stage requires a FeedbackProvider");
  return stage;
}

/** The workspace's half of the world. Other hosts have no panes and leave it empty. */
export function useStageWorkspace({ inView, active, single }: { inView: ReadonlySet<string>; active: string; single: boolean }): void {
  const stage = useStage();
  useLayoutEffect(() => stage.workspace({ inView, active, single }), [stage, inView, active, single]);
}
