"use client";

import {
  BarChart3,
  FileText,
  GitBranch,
  Highlighter,
  Link2,
  ListTree,
  MessageSquare,
  X,
} from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { ComponentType } from "react";
import Button from "@/components/ui/Button";
import type { PaneSecondaryPublication } from "@/components/workspace/PaneSecondary";
import {
  getSecondarySurfaceDefinition,
  type PaneSecondaryIconId,
  type WorkspaceSecondaryState,
  type WorkspaceSecondarySurfaceId,
} from "@/lib/panes/paneSecondaryModel";
import { getFocusableElements } from "@/lib/ui/getFocusableElements";
import { useBodyOverflowLock } from "@/lib/ui/useBodyOverflowLock";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import styles from "./MobileSecondaryPaneHost.module.css";

const SECONDARY_ICONS: Record<
  PaneSecondaryIconId,
  ComponentType<{ size?: number; "aria-hidden"?: "true" }>
> = {
  "bar-chart-3": BarChart3,
  "file-text": FileText,
  "git-branch": GitBranch,
  highlighter: Highlighter,
  "link-2": Link2,
  "list-tree": ListTree,
  "message-square": MessageSquare,
};

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
  const tabRefs = useRef(new Map<WorkspaceSecondarySurfaceId, HTMLButtonElement>());
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
      const tab = activeSurfaceId ? tabRefs.current.get(activeSurfaceId) : null;
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
  const tabId = (surfaceId: WorkspaceSecondarySurfaceId) =>
    `${baseId}-${surfaceId}-tab`;
  const panelId = (surfaceId: WorkspaceSecondarySurfaceId) =>
    `${baseId}-${surfaceId}-panel`;
  const selectSurface = (surfaceId: WorkspaceSecondarySurfaceId) => {
    onActiveSurfaceChange(secondaryPaneId, surfaceId);
    window.requestAnimationFrame(() => tabRefs.current.get(surfaceId)?.focus());
  };

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
          <div className={styles.tabs} role="tablist" aria-label="Secondary surfaces">
            {publication.surfaces.map((surface, index) => {
              const surfaceDefinition = getSecondarySurfaceDefinition(surface.id);
              const Icon = SECONDARY_ICONS[surfaceDefinition.iconId];
              const selected = surface.id === activeSurface.id;
              return (
                <button
                  key={surface.id}
                  ref={(element) => {
                    if (element) {
                      tabRefs.current.set(surface.id, element);
                    } else {
                      tabRefs.current.delete(surface.id);
                    }
                  }}
                  id={tabId(surface.id)}
                  type="button"
                  role="tab"
                  aria-controls={panelId(surface.id)}
                  aria-selected={selected}
                  aria-label={surfaceDefinition.title}
                  title={surfaceDefinition.title}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tab}
                  data-active={selected ? "true" : "false"}
                  onClick={() => selectSurface(surface.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                      event.preventDefault();
                      const direction = event.key === "ArrowRight" ? 1 : -1;
                      const nextIndex =
                        (index + direction + publication.surfaces.length) %
                        publication.surfaces.length;
                      const nextSurface = publication.surfaces[nextIndex];
                      if (nextSurface) {
                        selectSurface(nextSurface.id);
                      }
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      const firstSurface = publication.surfaces[0];
                      if (firstSurface) {
                        selectSurface(firstSurface.id);
                      }
                    } else if (event.key === "End") {
                      event.preventDefault();
                      const lastSurface =
                        publication.surfaces[publication.surfaces.length - 1];
                      if (lastSurface) {
                        selectSurface(lastSurface.id);
                      }
                    }
                  }}
                >
                  <Icon size={18} aria-hidden="true" />
                </button>
              );
            })}
          </div>
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
          id={panelId(activeSurface.id)}
          role="tabpanel"
          aria-labelledby={tabId(activeSurface.id)}
          className={styles.body}
        >
          {activeSurface.mobileBody ?? activeSurface.body}
        </div>
      </aside>
    </div>
  );
}
