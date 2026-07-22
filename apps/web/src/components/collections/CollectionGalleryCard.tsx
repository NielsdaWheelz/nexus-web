"use client";

import type { CSSProperties } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Pill from "@/components/ui/Pill";
import ResourceActivation from "@/components/ui/ResourceActivation";
import ResourceThumb from "@/components/ui/ResourceThumb";
import type { CollectionRowView } from "@/lib/collections/types";
import styles from "./CollectionGalleryCard.module.css";

/** Cover-forward card for the gallery view-mode. Same activation contract as the list row. */
export default function CollectionGalleryCard({
  row,
  viewTransitionName,
}: {
  row: CollectionRowView;
  viewTransitionName?: string;
}) {
  const itemStyle: CSSProperties | undefined = viewTransitionName
    ? { viewTransitionName }
    : undefined;
  const inner = (
    <>
      <ResourceThumb
        spec={row.lead}
        alt=""
        size="fill"
        className={styles.cover}
      />
      <span className={styles.title} data-row-text data-view-transition-part="title">
        {row.headline.text}
      </span>
      {row.signals[0] ? <span className={styles.meta}>{row.signals[0].value}</span> : null}
    </>
  );

  return (
    <li
      className={styles.item}
      data-collection-row-id={row.id}
      data-view-transition-part="row"
      style={itemStyle}
    >
      <ResourceActivation primary={row.primary} className={styles.card}>
        {inner}
      </ResourceActivation>
      {row.status ? (
        <span className={styles.badge}>
          <Pill tone={row.status.tone}>{row.status.label}</Pill>
        </span>
      ) : null}
      {row.actions?.length ? (
        <span className={styles.actions}>
          <ActionMenu
            options={row.actions}
            triggerAttributes={{ tabIndex: -1, "data-row-action-trigger": "true" }}
          />
        </span>
      ) : null}
    </li>
  );
}
