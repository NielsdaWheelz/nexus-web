"use client";
/** Listening progress this device could not read stands at downloads, its local-data surface,
 * only where no progress is shown. A saved catalog that could not refresh heals on admission,
 * focus, online and change, so it says nothing. Remote authored admission belongs to account sync. */
import { useState } from "react";
import { Fact } from "@/components/feedback/Fact";
import { retryListeningRead, useListening } from "@/lib/consumption/listening";
export function DeviceListeningStatus() {
  const listening = useListening();
  const [busy, setBusy] = useState(false);
  if (listening.error === null || listening.facts !== null) return null;
  return <Fact line={{ fact: "couldn’t read listening progress on this device." }} verbs={[{ label: "retry", commandKey: "RetryListeningRead", busy,
    run: () => { setBusy(true); void retryListeningRead().finally(() => setBusy(false)); } }]} />;
}
