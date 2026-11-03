"use client";

/** What stays in flow. `Fact` stands where an object would, `Failed` is the same for a failed
 * read, `Field` sits under its input. `VerbControl` is every feedback verb, in flow or floating.
 *
 * Invariants: a line speaks once per sentence it shows, so a changed line speaks again. A verb
 * that withdraws while it holds focus gives focus to its nearest home, if it has one. */
import * as Icon from "@/lib/ui/icons";
import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { topModal } from "@/lib/ui/overlay";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { Announcement, useActiveRegion, useTransportVerbs } from "./Feedback";
import { sentence, type CommandVerb, type Line, type Verb, type Verbs } from "./stage";
import styles from "./Fact.module.css";

/** Where focus goes when what held it withdraws: the nearest pane landmark, dialog or
 * `tabindex=-1` ancestor. */
const HOME = "[data-pane-focus-landmark], [role='dialog'], [tabindex='-1']";

export const takeFocus = (element: HTMLElement) => element.focus({ preventScroll: true });

/** Withdrawal restores only owned focus: what `owner` held when it unmounted passes to `target`,
 * unless a command already handed it elsewhere, or a modal now owns it. `target` is asked once
 * the commit has settled, and is given `owner`'s home, read while `owner` still stood. An owner
 * nested in another's lets the outer one decide: its cleanup runs first and moves focus. */
export function useFocusReturn(owner: RefObject<HTMLElement | null>, target: (home: HTMLElement | null) => HTMLElement | null, give = takeFocus) {
  const latest = useRef({ target, give });
  latest.current = { target, give };
  useLayoutEffect(() => () => {
    const focused = document.activeElement;
    const element = owner.current;
    if (!element?.contains(focused)) return;
    // Layout cleanups run before the commit detaches the owner, so its place can still be read.
    const home = element.parentElement?.closest<HTMLElement>(HOME) ?? null;
    queueMicrotask(() => {
      const current = document.activeElement;
      if (current !== focused && current !== document.body && current?.isConnected) return;
      const next = latest.current.target(home);
      const modal = topModal();
      if (!next?.isConnected || next.closest("[hidden], [inert]") || modal && !modal.element?.contains(next)) return;
      latest.current.give(next);
    });
  }, [owner]);
}

const sameVerb = (a: Verb, b: Verb) => "href" in a
  ? "href" in b && a.label === b.label && a.href === b.href
  : "commandKey" in b && a.commandKey === b.commandKey;

/** Where a withdrawn verb's focus goes, and how, in place of its home: a slip's room keeps it among
 * the room's own controls. */
type Withdrawal = { target(): HTMLElement | null; give(next: HTMLElement): void };

/** A held control never changes its command: what was under the pointer or focus stays, blocked.
 * `onActivated` runs before a command, and after a link that navigated. A verb withdrawn while it
 * holds focus returns it home, or to `withdrawal`'s target, unless it navigated, which took focus
 * with it. */
export function VerbControl({ verb, contextId, onActivated, withdrawal }: { verb: Verb; contextId: string; onActivated?: () => void; withdrawal?: Withdrawal }) {
  const [held, setHeld] = useState<Verb | null>(null);
  const interaction = useRef({ pointer: false, focus: false });
  const root = useRef<HTMLSpanElement>(null);
  const navigated = useRef(false);
  const reasonId = useId();
  useFocusReturn(root, home => navigated.current ? null : withdrawal ? withdrawal.target() : home, withdrawal?.give);
  const replaced = held !== null && !sameVerb(held, verb);
  const shown = replaced ? held : verb;
  const reason = replaced ? "this action is no longer available" : shown.disabledReason;
  const blocked = Boolean(reason || shown.busy);
  const hold = (kind: "pointer" | "focus", value: boolean) => {
    interaction.current[kind] = value;
    if (value) setHeld(current => current ?? verb);
    else if (!interaction.current.pointer && !interaction.current.focus) setHeld(null);
  };
  const events = {
    onMouseEnter: () => hold("pointer", true),
    onMouseLeave: () => hold("pointer", false),
    onFocus: () => {
      navigated.current = false;
      hold("focus", true);
    },
    onBlur: () => hold("focus", false),
  };
  // A blocked control stops activation before this runs; a blocked link has no href.
  const activate = (event: TargetActivationEvent) => {
    if ("href" in shown) {
      const result = shown.onActivate?.(event);
      navigated.current = result === "handled-default" || result === "handled-new-pane";
      if (navigated.current) onActivated?.();
      return;
    }
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind !== "Open") return;
    onActivated?.();
    shown.run(activation.intent);
  };
  const describedBy = reason ? `${contextId} ${reasonId}` : contextId;
  return <span ref={root} className={styles.verb}>
    {"href" in shown ? <ButtonLink
      {...events}
      key={shown.href}
      href={shown.href}
      target={shown.target}
      rel={shown.target === "_blank" ? "noopener noreferrer" : undefined}
      data-workspace-rich-target={shown.onActivate ? "true" : undefined}
      aria-disabled={blocked || undefined}
      aria-busy={shown.busy || undefined}
      aria-describedby={describedBy}
      onClick={activate}
      onKeyDown={activate}
    >{shown.label}</ButtonLink> : <Button
      {...events}
      key={shown.commandKey}
      icon={shown.copied ? <Icon.Check /> : undefined}
      aria-busy={shown.busy || undefined}
      aria-disabled={blocked || undefined}
      aria-describedby={describedBy}
      onClick={activate}
      onKeyDown={activate}
    >{shown.label}</Button>}
    {"href" in shown || !shown.copied ? null : <Announcement text="copied" level="Polite" occurrence={shown.copied} />}
    {reason ? <span id={reasonId} className={styles.blocked}>{reason}</span> : null}
  </span>;
}

/** By position: a verb's control outlives a change of verb, so the guard above can hold. */
function FactVerbs({ verbs, contextId }: { verbs?: Verbs; contextId: string }) {
  return verbs ? <div className={styles.verbs}>
    <VerbControl verb={verbs[0]} contextId={contextId} />
    {verbs[1] ? <VerbControl verb={verbs[1]} contextId={contextId} /> : null}
  </div> : null;
}

/** Says `text` once, politely, while `speak` holds, and again each time `text` changes. `speak`
 * may come true late: the announcement stays mounted, so one sentence never speaks twice. */
function Spoken({ text, speak }: { text: string; speak: boolean }) {
  const [said, setSaid] = useState({ text, occurrence: {} });
  if (said.text !== text) setSaid({ text, occurrence: {} });
  return <Announcement text={text} level={speak ? "Polite" : "None"} occurrence={said.occurrence} />;
}

/** One sentence, optional detail, at most two verbs. `speak` announces each sentence it shows. */
export function Fact({ line, verbs, speak = false }: { line: Line; verbs?: Verbs; speak?: boolean }) {
  const lineId = useId();
  const text = sentence(line);
  return <div className={styles.fact}>
    <p id={lineId} className={styles.line}>{text}</p>
    <FactVerbs verbs={verbs} contextId={lineId} />
    <Spoken text={text} speak={speak} />
  </div>;
}

/** A failed read, where its object stood. It speaks from the active region alone, so a restored
 * workspace says one line. `retry` keeps its label: a read says `retry`. A same-system defect is
 * not a failed read: it throws here and reaches the boundary. */
export function Failed({ error, noun, retry }: { error: unknown; noun: string; retry?: Pick<CommandVerb, "run" | "busy" | "disabledReason"> }) {
  const speak = useActiveRegion();
  const verbsFor = useTransportVerbs();
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const transport = transportOf(error);
  const verbs = verbsFor(transport, { retry: retry && { ...retry, label: "retry", commandKey: `retry ${noun}` } });
  return <Fact line={TRANSPORT_LINES[transport].read(noun)} verbs={verbs ?? undefined} speak={speak} />;
}

/** Beneath its input; the input's owner absorbs the growth. `id` names the line alone, so the
 * input's `aria-describedby` and each verb's read the line, not the verbs beside it. The active
 * region speaks the line as it appears and as it changes. */
export function Field({ id, line, verbs }: { id: string; line: Line; verbs?: Verbs }) {
  const speak = useActiveRegion();
  const text = sentence(line);
  return <div className={styles.field}>
    <span id={id}>{text}</span>
    <FactVerbs verbs={verbs} contextId={id} />
    <Spoken text={text} speak={speak} />
  </div>;
}
