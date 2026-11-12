"use client";

import Button from "@/components/ui/Button";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import type { LiveReference as Reference } from "@/lib/chat/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { resolveResourceItem } from "@/lib/resources/items";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";

/** Labels hydrate from the current resource. No excerpt or reader revision is
 * retained in the message. The destination reader resolves live coordinates. */
export default function LiveReference({ reference, item, locationAvailable = true, label }: {
  reference: Reference; item: Schema<"ResourceItemOut"> | null; locationAvailable?: boolean; label?: string;
}) {
  const runtime = usePaneRuntime();
  if (!item || item.missing) return <span>source unavailable</span>;
  const href = item.activation.href;
  const open = (event: TargetActivationEvent) => {
    if (!href || !runtime || item.activation.kind !== "route") return;
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Unowned") return;
    event.preventDefault();
    if (activation.kind !== "Open") return;
    runtime.activateTarget({ target: { href }, disposition: { kind: activation.intent === "new_pane" ? "Fork" : "Follow" },
      entry: { kind: "InspectSource", target: { kind: "live_reference", reference: locationAvailable ? reference : { ...reference, locator: null } }, purpose: "Open" } });
  };
  return <span>{href ? <a href={href} onClick={open} onKeyDown={open} data-workspace-rich-target="true">{label ?? item.label}</a> : <span>{label ?? item.label}</span>}
    {!locationAvailable ? <span> · selected passage unavailable</span> : null}</span>;
}

export function RetrievalReference({ retrieval, label }: { retrieval: Schema<"TrustRetrievalOut"> | Schema<"ChatCitationOut">; label?: string }) {
  return retrieval.target.kind === "url" ? <a href={retrieval.target.url}>{label ?? new URL(retrieval.target.url).hostname}</a>
    : <LiveReference reference={retrieval.target.reference} item={retrieval.item} locationAvailable={retrieval.location_available} label={label} />;
}

export function DraftReference({ reference, onRemove }: { reference: Reference; onRemove(): void }) {
  const stale = useChangeStamp("Metadata", "Notes", "NoteBodies");
  const read = usePaneFreeServerValue({ key: `draft-reference:${reference.resource_ref}`, stale, load: signal => resolveResourceItem(reference.resource_ref, signal) });
  return <div role="group" aria-label="attached reference">
    {read.status === "ready" ? <LiveReference reference={reference} item={read.data} /> : read.status === "failed" ? <Failed error={read.error} noun="source" retry={{ run: read.refetch, busy: read.retrying }} /> : <Ruling />}
    <Button onClick={onRemove}>remove reference</Button>
  </div>;
}
