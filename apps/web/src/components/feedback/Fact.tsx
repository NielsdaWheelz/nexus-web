"use client";

/** What stays in flow. `Fact` stands where an object would, `Failed` is the same for a failed
 * read, `Field` sits under its input. `VerbControl` is every feedback verb, in flow or floating. */
import { Check } from "lucide-react";
import { useContext, useId, useRef, useState, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { subscribeAdmission, updateRemedy } from "@/lib/native/admission";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import { Announcement, useActiveRegion } from "./Feedback";
import { ShellContext, transportVerbs, type CommandVerb, type Line, type Verb, type Verbs } from "./stage";
import styles from "./Fact.module.css";

const sameVerb = (a: Verb, b: Verb) => "href" in a
  ? "href" in b && a.label === b.label && a.href === b.href
  : "commandKey" in b && a.commandKey === b.commandKey;

/** A held control never changes its command: what was under the pointer or focus stays, blocked.
 * `onActivated` runs before a command, and after a link that navigated. */
export function VerbControl({ verb, contextId, onActivated }: { verb: Verb; contextId: string; onActivated?: () => void }) {
  const [held, setHeld] = useState<Verb | null>(null);
  const interaction = useRef({ pointer: false, focus: false });
  const reasonId = useId();
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
    onFocus: () => hold("focus", true),
    onBlur: () => hold("focus", false),
  };
  // A blocked control stops activation before this runs; a blocked link has no href.
  const activate = (event: TargetActivationEvent) => {
    if ("href" in shown) {
      const result = shown.onActivate?.(event);
      if (result === "handled-default" || result === "handled-new-pane") onActivated?.();
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
  return <span className={styles.verb}>
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
      icon={shown.copied ? <Check /> : undefined}
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

/** One sentence, optional detail, at most two verbs. `speak` announces once, politely, and may
 * come true late: the announcement stays mounted so it cannot speak twice. */
export function Fact({ line, verbs, speak = false }: { line: Line; verbs?: Verbs; speak?: boolean }) {
  const lineId = useId();
  const [occurrence] = useState({});
  const text = line.reason ? `${line.fact} ${line.reason}` : line.fact;
  return <div className={styles.fact}>
    <p id={lineId} className={styles.line}>{text}</p>
    <FactVerbs verbs={verbs} contextId={lineId} />
    <Announcement text={text} level={speak ? "Polite" : "None"} occurrence={occurrence} />
  </div>;
}

/** A failed read, where its object stood. It speaks from the active region alone, so a restored
 * workspace says one line. `retry` keeps its label: a read says `retry`. A same-system defect is
 * not a failed read: it throws here and reaches the boundary. */
export function Failed({ error, noun, retry }: { error: unknown; noun: string; retry?: Pick<CommandVerb, "run" | "busy" | "disabledReason"> }) {
  const { signIn } = useContext(ShellContext);
  const speak = useActiveRegion();
  useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  const transport = transportOf(error);
  const verb = retry && { ...retry, label: "retry", commandKey: `retry ${noun}` };
  return <Fact line={TRANSPORT_LINES[transport].read(noun)} verbs={transportVerbs(transport, { retry: verb, signIn }) ?? undefined} speak={speak} />;
}

/** Beneath its input; the input's owner absorbs the growth. */
export function Field({ id, line, verbs }: { id: string; line: Line; verbs?: Verbs }) {
  return <div id={id} className={styles.field}>
    {line.reason ? `${line.fact} ${line.reason}` : line.fact}
    <FactVerbs verbs={verbs} contextId={id} />
  </div>;
}
