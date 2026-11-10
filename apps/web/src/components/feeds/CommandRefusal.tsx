"use client";

/** A sending dialog's refused source command: its fact, and `check`, which forgets the refusal and
 * rereads, so the dialog's confirm re-arms on current facts. The press removes the Fact it stands
 * in, so focus it held moves to the dialog. The refusal was said here, so it goes with the dialog. */
import { useEffect } from "react";
import { Fact } from "@/components/feedback/Fact";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";

export default function CommandRefusal({ subject, reread }: { readonly subject: string; readonly reread: () => void }) {
  const { ctx } = useActionRuntime();
  const { release } = ctx.feeds;
  useEffect(() => () => release(subject), [release, subject]);
  const pending = ctx.feeds.pending(subject);
  if (pending?.phase !== "Refused" || pending.refusal === null) return null;
  const { key } = pending;
  return <div>
    <Fact line={pending.refusal} speak verbs={[{ label: "check", commandKey: `check ${key}`, run: () => {
      ctx.feeds.review(key);
      reread();
    } }]} />
  </div>;
}
