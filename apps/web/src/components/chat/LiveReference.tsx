"use client";

import type { MouseEvent } from "react";
import type { Schema } from "@/lib/api/wire";
import type { LiveReference as Reference } from "@/lib/chat/wire";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { suppressSelectionActivation, type TargetActivationEvent } from "@/lib/ui/targetActivation";

/** Inline markers and resolved figures share source-follow/fork intent. */
export function useLiveReferenceLink({ reference, item, locationAvailable }: {
  reference: Reference; item: Schema<"ResourceItemOut"> | null; locationAvailable: boolean;
}) {
  const runtime = usePaneRuntime();
  if (!item || item.missing) return null;
  const annotation = reference.field === "annotation";
  const href = annotation ? `/highlights/${parseResourceRef(reference.resource_ref)!.id}#annotation` : item.activation.href;
  if (href === null) return null;
  const open = (event: TargetActivationEvent) => {
    if (!annotation && item.activation.kind !== "route") return;
    activateTargetLink({ event, runtime, target: { href, labelHint: item.label },
      entry: { kind: "InspectSource", target: { kind: "live_reference", reference: locationAvailable ? reference : { ...reference, locator: null } }, purpose: "Open" } });
  };
  return { href, onKeyDown: open, "data-workspace-rich-target": "true", onClick: (event: MouseEvent<HTMLAnchorElement>) => {
    if (!suppressSelectionActivation(event)) open(event);
  } };
}

export function unavailableReferenceLabel(reference: Reference): string {
  if (reference.field === "annotation") return "annotation unavailable";
  const scheme = parseResourceRef(reference.resource_ref)?.scheme;
  const kind = scheme === "message" ? "message" : scheme ? resourceTypeLabel(scheme) : "source";
  return `${kind} unavailable`;
}

/** Labels hydrate from the current resource; unavailable citations retain their marker. */
export default function LiveReference({ reference, item, locationAvailable = true, label }: {
  reference: Reference; item: Schema<"ResourceItemOut"> | null; locationAvailable?: boolean; label?: string;
}) {
  const link = useLiveReferenceLink({ reference, item, locationAvailable });
  if (!item || item.missing) {
    const unavailable = unavailableReferenceLabel(reference);
    return <span>{label ? <>{label}<span className="sr-only"> · {unavailable}</span></> : unavailable}</span>;
  }
  const unavailable = !locationAvailable ? "selected passage unavailable" : reference.field === "annotation" ? null
    : item.activation.unavailable_reason === "source_unavailable" ? "source unavailable"
      : item.activation.unavailable_reason === "location_unavailable" ? "selected passage unavailable" : null;
  return <span>{link ? <a {...link}>{label ?? item.label}</a> : <span>{label ?? item.label}</span>}
    {unavailable ? <span className={label ? "sr-only" : undefined}> · {unavailable}</span> : null}</span>;
}

export function RetrievalReference({ retrieval, label }: { retrieval: Schema<"TrustRetrievalOut"> | Schema<"ChatCitationOut">; label?: string }) {
  return retrieval.target.kind === "url" ? <a href={retrieval.target.url} onClick={suppressSelectionActivation}>{label ?? new URL(retrieval.target.url).hostname}</a>
    : <LiveReference reference={retrieval.target.reference} item={retrieval.item} locationAvailable={retrieval.location_available} label={label} />;
}
