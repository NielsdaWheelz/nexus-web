"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import Button from "@/components/ui/Button";
import SecondarySurfaceTabs, {
  secondarySurfacePanelId,
  secondarySurfaceTabId,
} from "@/components/workspace/SecondarySurfaceTabs";
import type { PaneSecondaryPublication } from "@/components/workspace/PaneSecondary";
import {
  getSecondarySurfaceDefinition,
  type WorkspaceSecondaryState,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import styles from "./MobileSecondaryPaneHost.module.css";

interface MobileSecondaryPaneHostProps {
  secondaryPaneId: string;
  secondary: WorkspaceSecondaryState | null;
  publication: PaneSecondaryPublication | null;
  onClose: (secondaryPaneId: string) => void;
  onActiveSurfaceChange: (
    secondaryPaneId: string,
    surfaceId: WorkspaceSecondarySurfaceId,
  ) => void;
}

export default function MobileSecondaryPaneHost({
  secondaryPaneId,
  secondary,
  publication,
  onClose,
  onActiveSurfaceChange,
}: MobileSecondaryPaneHostProps) {
  const baseId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const activeSurface =
    publication?.surfaces.find((surface) => surface.id === secondary?.activeSurfaceId) ??
    null;
  const activeSurfaceId = activeSurface?.id ?? null;
  const active = Boolean(
    secondary?.visibility === "visible" &&
      publication &&
      secondary.groupId === publication.groupId &&
      activeSurface,
  );

  useBodyOverflowLock(active);
  useFocusTrap(sheetRef, active);

  useEffect(() => {
    if (!active) {
      return;
    }
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) {
        returnTarget.focus();
        return;
      }
      document
        .querySelector<HTMLElement>('[data-active="true"] [data-pane-chrome-focus="true"]')
        ?.focus();
    };
  }, [active]);

  useEffect(() => {
    if (!active || !sheetRef.current) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const tab = sheetRef.current?.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      const firstFocusable = getFocusableElements(sheetRef.current!)[0];
      (tab ?? firstFocusable ?? sheetRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, activeSurfaceId]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(secondaryPaneId);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, onClose, secondaryPaneId]);

  if (!active || !publication || !secondary || !activeSurface) {
    return null;
  }

  const activeSurfaceDefinition = getSecondarySurfaceDefinition(activeSurface.id);

  return (
    <div
      className={styles.backdrop}
      data-testid="mobile-secondary-backdrop"
      onClick={() => onClose(secondaryPaneId)}
    >
      <aside
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={activeSurfaceDefinition.title}
        data-testid="mobile-secondary-host"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <SecondarySurfaceTabs
            baseId={baseId}
            surfaces={publication.surfaces}
            activeSurfaceId={activeSurface.id}
            onSelect={(surfaceId) => onActiveSurfaceChange(secondaryPaneId, surfaceId)}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Close ${activeSurfaceDefinition.title}`}
            onClick={() => onClose(secondaryPaneId)}
          >
            <X size={15} aria-hidden="true" />
          </Button>
        </header>
        <div
          id={secondarySurfacePanelId(baseId, activeSurface.id)}
          role="tabpanel"
          aria-labelledby={secondarySurfaceTabId(baseId, activeSurface.id)}
          className={styles.body}
        >
          {activeSurface.mobileBody ?? activeSurface.body}
        </div>
      </aside>
    </div>
  );
}
