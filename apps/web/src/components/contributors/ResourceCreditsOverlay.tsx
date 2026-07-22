"use client";

import { Fragment } from "react";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import type { PaneHeaderCreditGroup } from "@/lib/panes/paneHeaderModel";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import styles from "./ResourceCreditsOverlay.module.css";

interface ResourceCreditsOverlayProps {
  readonly open: boolean;
  readonly title: string;
  readonly creditGroups: readonly PaneHeaderCreditGroup[];
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}

function CompleteCredits({
  title,
  creditGroups,
}: Pick<ResourceCreditsOverlayProps, "title" | "creditGroups">) {
  return (
    <div
      className={styles.content}
      data-resource-credits-complete="true"
      data-testid="resource-credits-complete"
    >
      <div className={styles.resourceTitle} dir="auto">
        {title}
      </div>
      <div className={styles.groups}>
        {creditGroups.map((group, groupIndex) => (
          <div
            key={
              group.kind === "authors"
                ? "authors"
                : `${group.label}-${groupIndex}`
            }
            className={styles.group}
          >
            <div className={styles.role}>
              {group.kind === "authors" ? "Authors" : group.label}
            </div>
            <div className={styles.names}>
              {group.credits.map((credit, creditIndex) => (
                <Fragment key={`${credit.label}-${creditIndex}`}>
                  {creditIndex > 0 ? ", " : null}
                  {credit.href ? (
                    <a href={credit.href} dir="auto">
                      {credit.label}
                    </a>
                  ) : (
                    <span dir="auto">{credit.label}</span>
                  )}
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ResourceCreditsOverlay({
  open,
  title,
  creditGroups,
  returnFocusTo,
  returnFocusFallback,
  onClose,
}: ResourceCreditsOverlayProps) {
  const isMobile = useIsMobileViewport();
  const content = <CompleteCredits title={title} creditGroups={creditGroups} />;

  if (isMobile) {
    return (
      <MobileSheet
        active={open}
        onDismiss={onClose}
        ariaLabel="Credits"
        returnFocusTo={returnFocusTo}
        returnFocusFallback={returnFocusFallback}
      >
        {content}
      </MobileSheet>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Credits"
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
    >
      {content}
    </Dialog>
  );
}
