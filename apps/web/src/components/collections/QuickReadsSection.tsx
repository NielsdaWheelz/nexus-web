"use client";

import { useLayoutEffect, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import { useResource } from "@/lib/api/useResource";
import { useConsumptionProjectionRevision } from "@/lib/consumption/projectionRevision";
import { useLibraryPlacementRevision } from "@/lib/libraries/placementRevision";
import { getQuickReads } from "@/lib/resonance/client";
import type { SlateSnapshot } from "@/lib/resonance/contract";
import { presentSlateItem } from "@/lib/resonance/presentSlateItem";

export default function QuickReadsSection({ isActive }: { isActive: boolean }) {
  const consumption = useConsumptionProjectionRevision();
  const placement = useLibraryPlacementRevision();
  const requestKey = isActive
    ? `lectern:quick-reads:${consumption.revision}:${placement.revision}`
    : null;
  const resource = useResource<SlateSnapshot>({
    cacheKey: requestKey,
    load: getQuickReads,
  });
  const focusedRef = useRef<{ target: HTMLElement; section: HTMLElement } | null>(null);

  useLayoutEffect(() => {
    if (!isActive) {
      focusedRef.current = null;
      return;
    }
    const focused = focusedRef.current;
    if (!focused || focused.target.isConnected) return;
    focusedRef.current = null;
    if (
      document.activeElement === document.body &&
      focused.section.isConnected &&
      !focused.section.closest("[inert]")
    ) {
      focused.section.focus({ preventScroll: true });
    }
  }, [isActive, requestKey, resource.status]);

  return (
    <PaneSection
      title="Quick reads"
      aria-label="Quick reads"
      tabIndex={-1}
      onFocusCapture={(event) => {
        focusedRef.current = { target: event.target, section: event.currentTarget };
      }}
      onBlurCapture={(event) => {
        // Removal can strand focus without a live blur target. Real departures
        // clear ownership, including a deliberate move to another pane.
        if (event.target.isConnected) focusedRef.current = null;
      }}
    >
      <CollectionView
        returnScope="Lectern.QuickReads"
        ariaLabel="Quick reads"
        rows={resource.status === "ready" ? resource.data.items.map(presentSlateItem) : []}
        status={resource.status === "idle" ? "loading" : resource.status}
        error={resource.status === "error" ? (
          <FeedbackNotice
            content={{
              tone: "Danger",
              title: "Couldn’t load quick reads.",
              requestId: resource.error.requestId,
            }}
            announcement="Polite"
            actions={[{ label: "Retry", onClick: resource.retry }]}
          />
        ) : undefined}
        empty={<p>No quick reads.</p>}
        surface={false}
      />
    </PaneSection>
  );
}
