"use client";

import { Fragment } from "react";
import type { Presence } from "@/lib/api/presence";
import type { PublicationDate } from "@/lib/dates/publicationDate";
import { formatCollectionPublicationDate } from "@/components/collections/collectionRowFormatting";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import type { PaneHeaderCreditGroup } from "@/lib/panes/paneHeaderModel";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";
import styles from "./MediaInfoOverlay.module.css";

interface MediaInfoOverlayProps {
  readonly open: boolean;
  readonly title: string;
  readonly creditGroups: readonly PaneHeaderCreditGroup[];
  readonly originalPublishedDate: Presence<PublicationDate>;
  readonly editionPublishedDate: Presence<PublicationDate>;
  readonly publisher: string | null;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
}

function MediaInfo({
  title,
  creditGroups,
  originalPublishedDate,
  editionPublishedDate,
  publisher,
}: Pick<
  MediaInfoOverlayProps,
  | "title"
  | "creditGroups"
  | "originalPublishedDate"
  | "editionPublishedDate"
  | "publisher"
>) {
  return (
    <div className={styles.content}>
      <div className={styles.resourceTitle} dir="auto">
        {title}
      </div>
      <dl className={styles.facts}>
        <div className={styles.group}>
          <dt className={styles.role}>First published</dt>
          <dd className={styles.names}>
            {originalPublishedDate.kind === "Present" ? (
              <time dateTime={originalPublishedDate.value}>
                {formatCollectionPublicationDate(originalPublishedDate.value)}
              </time>
            ) : (
              "Unknown"
            )}
          </dd>
        </div>
        <div className={styles.group}>
          <dt className={styles.role}>This edition</dt>
          <dd className={styles.names}>
            {editionPublishedDate.kind === "Present" ? (
              <time dateTime={editionPublishedDate.value}>
                {formatCollectionPublicationDate(editionPublishedDate.value)}
              </time>
            ) : (
              "Unknown"
            )}
          </dd>
        </div>
        {publisher ? (
          <div className={styles.group}>
            <dt className={styles.role}>Publisher</dt>
            <dd className={styles.names}>{publisher}</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.groups}>
        {creditGroups.map((group, groupIndex) => (
          <div
            key={
              group.kind === "Authors"
                ? "Authors"
                : `${group.label}-${groupIndex}`
            }
            className={styles.group}
          >
            <div className={styles.role}>
              {group.kind === "Authors" ? "Authors" : group.label}
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

export default function MediaInfoOverlay({
  open,
  title,
  creditGroups,
  originalPublishedDate,
  editionPublishedDate,
  publisher,
  returnFocusTo,
  returnFocusFallback,
  onClose,
}: MediaInfoOverlayProps) {
  const isMobile = useIsMobileViewport();
  const content = (
    <MediaInfo
      title={title}
      creditGroups={creditGroups}
      originalPublishedDate={originalPublishedDate}
      editionPublishedDate={editionPublishedDate}
      publisher={publisher}
    />
  );

  if (isMobile) {
    return (
      <MobileSheet
        active={open}
        onDismiss={onClose}
        ariaLabel="Media info"
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
      title="Media info"
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
    >
      {content}
    </Dialog>
  );
}
