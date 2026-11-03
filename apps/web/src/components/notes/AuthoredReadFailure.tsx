"use client";

import { Fact } from "@/components/feedback/Fact";
import { isAuthoredStorageFailure } from "@/lib/notes/runtime";

/** A cold local read that failed, where its object would stand, with a real read retry: `couldn’t
 * open {noun} on this device.` Local reads have no transport, so a singular noun reads well. A
 * refresh over shown writing is no site of this: the editor is the proof. Invariant defects keep
 * their boundary. */
export default function AuthoredReadFailure({ error, retry, pending = false, noun }: {
  error: unknown | null; retry(): void; pending?: boolean; noun: string;
}) {
  if (error === null) return null;
  if (!isAuthoredStorageFailure(error)) throw error;
  return <Fact line={{ fact: `couldn’t open ${noun} on this device.` }}
    verbs={[{ label: "retry", commandKey: "RetryAuthoredRead", run: retry, busy: pending }]} />;
}
