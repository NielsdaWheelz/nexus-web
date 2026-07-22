"use client";

import type {
  PaneHeaderCreditGroup,
  PaneResourceHeaderState,
} from "@/lib/panes/paneHeaderModel";
import styles from "./ResourceHead.module.css";

interface ResourceHeadProps {
  readonly id: string;
  readonly resource: PaneResourceHeaderState;
}

function Credits({ groups }: { groups: readonly PaneHeaderCreditGroup[] }) {
  if (groups.length === 0) {
    return <span aria-hidden="true">&nbsp;</span>;
  }
  return groups.map((group, groupIndex) => (
    <span key={group.kind === "authors" ? "authors" : `${group.label}-${groupIndex}`}>
      {groupIndex > 0 ? " · " : null}
      {group.kind === "authors" ? (
        <span className="sr-only">Authors: </span>
      ) : (
        `${group.label}: `
      )}
      {group.credits.map((credit, creditIndex) => (
        <span key={`${credit.label}-${creditIndex}`}>
          {creditIndex > 0 ? ", " : null}
          <span dir="auto">{credit.label}</span>
        </span>
      ))}
    </span>
  ));
}

export default function ResourceHead({ id, resource }: ResourceHeadProps) {
  const pending = resource.status === "pending";
  const title = pending ? resource.accessibleLabel : resource.title;
  const creditGroups = resource.status === "ready" ? resource.creditGroups : [];

  return (
    <div className={styles.resourceHead} data-resource-head="true" data-status={resource.status}>
      <h1
        id={id}
        className={styles.title}
        dir="auto"
        aria-busy={pending || undefined}
        title={pending ? undefined : title}
      >
        {pending ? (
          <>
            <span className={styles.titleSkeleton} aria-hidden="true" />
            <span className="sr-only">{resource.accessibleLabel}</span>
          </>
        ) : (
          title
        )}
      </h1>
      <p className={styles.credits} data-resource-credits="true">
        <Credits groups={creditGroups} />
      </p>
    </div>
  );
}
