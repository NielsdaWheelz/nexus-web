"use client";

/** A sending dialog's refused podcast command: its fact, and `check`, which forgets the refusal and
 * rereads, so the dialog's confirm re-arms on current facts. The press removes the Fact it stands
 * in, so focus it held moves to the dialog. The refusal was said here, so it goes with the dialog. */
import { useEffect, useRef } from "react";
import { Fact } from "@/components/feedback/Fact";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";

export default function CommandRefusal({ subject, reread }: { readonly subject: string; readonly reread: () => void }) {
  const { ctx } = useActionRuntime();
  const region = useRef<HTMLDivElement>(null);
  const { release } = ctx.podcasts;
  useEffect(() => () => release(subject), [release, subject]);
  const pending = ctx.podcasts.pending(subject);
  if (pending?.phase !== "Refused" || pending.refusal === null) return null;
  const { key } = pending;
  return <div ref={region}>
    <Fact line={pending.refusal} speak verbs={[{ label: "check", commandKey: `check ${key}`, run: () => {
      if (region.current?.contains(document.activeElement)) region.current.closest<HTMLElement>('[role="dialog"]')?.focus();
      ctx.podcasts.review(key);
      reread();
    } }]} />
  </div>;
}
