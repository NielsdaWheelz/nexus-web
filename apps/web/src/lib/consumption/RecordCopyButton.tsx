"use client";

import { Announcement } from "@/components/feedback/Announcement";
import { useOutcome } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { useThrowLater } from "@/lib/api/serverState";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";

/** Feedback belongs to the exact record text offered by this control. */
export default function RecordCopyButton({ text, className }: { readonly text: string; readonly className?: string }) {
  const copied = useCopyFeedback(text);
  const outcome = useOutcome();
  const throwLater = useThrowLater();
  return <>
    <Button className={className} onClick={async () => {
      try { await copied.copy(text); }
      catch (error) {
        if (error instanceof ClipboardWriteUnavailableError) outcome.say({ fact: "couldn’t copy the record." });
        else throwLater({ error });
      }
    }}>Copy as text</Button>
    {copied.occurrence !== null ? <Announcement text="copied" level="Polite" occurrence={copied.occurrence} /> : null}
  </>;
}
