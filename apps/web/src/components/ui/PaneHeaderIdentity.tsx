"use client";

import type { ReactElement, ReactNode } from "react";
import type {
  PaneHeaderCredit,
  PaneHeaderCreditGroup,
  PaneHeaderMeta,
  PaneHeaderModel,
} from "@/lib/panes/paneHeaderModel";
import styles from "./PaneHeaderIdentity.module.css";

type PaneHeaderProjection = "Desktop" | "Mobile";

interface PaneHeaderIdentityProps {
  readonly id: string;
  readonly model: PaneHeaderModel;
  readonly projection: PaneHeaderProjection;
}

const SHORT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
};

function pluralize(unit: string, value: number): string {
  if (value === 1) return unit;
  if (/(s|x|z|ch|sh)$/.test(unit)) return `${unit}es`;
  if (/[^aeiou]y$/.test(unit)) return `${unit.slice(0, -1)}ies`;
  return `${unit}s`;
}

function formatMeta(meta: PaneHeaderMeta): string | null {
  switch (meta.kind) {
    case "None":
    case "Pending":
      return null;
    case "Count":
      return `${meta.value.toLocaleString()} ${pluralize(meta.unit, meta.value)}`;
    case "Date": {
      // `resolvePaneHeaderModel` already proved this is a real calendar day, so
      // the component-wise read cannot fail — and it fixes the day as a *local*
      // one, which `new Date(iso)` would drift by a time zone.
      const [year, month, day] = meta.iso.split("-").map(Number);
      return new Intl.DateTimeFormat(undefined, SHORT_DATE_FORMAT).format(
        new Date(year, month - 1, day),
      );
    }
  }
}

function maxVisibleCredits(projection: PaneHeaderProjection): 1 | 2 {
  switch (projection) {
    case "Desktop":
      return 2;
    case "Mobile":
      return 1;
  }
}

/**
 * Credits fill the support line from the front until the projection's cap is
 * spent; whatever is left is counted, never listed.
 */
function Credits({
  groups,
  maxVisible,
}: {
  groups: readonly PaneHeaderCreditGroup[];
  maxVisible: 1 | 2;
}) {
  const visibleGroups: {
    group: PaneHeaderCreditGroup;
    credits: readonly PaneHeaderCredit[];
  }[] = [];
  let visibleCreditCount = 0;
  for (const group of groups) {
    if (visibleCreditCount === maxVisible) break;
    const credits = group.credits.slice(0, maxVisible - visibleCreditCount);
    visibleGroups.push({ group, credits });
    visibleCreditCount += credits.length;
  }
  const hiddenCreditCount =
    groups.reduce((count, group) => count + group.credits.length, 0) -
    visibleCreditCount;

  return (
    <>
      {visibleGroups.map(({ group, credits }, groupIndex) => (
        <span
          key={
            group.kind === "Authors"
              ? "Authors"
              : `${group.label}-${groupIndex}`
          }
          className={styles.creditGroup}
        >
          {groupIndex > 0 ? <span className={styles.fixed}> · </span> : null}
          {group.kind === "Authors" ? (
            <span className="sr-only">Authors: </span>
          ) : (
            <span className={styles.fixed}>{group.label}: </span>
          )}
          {credits.map((credit, creditIndex) => (
            <span key={`${credit.label}-${creditIndex}`} className={styles.credit}>
              {creditIndex > 0 ? <span className={styles.fixed}>, </span> : null}
              {credit.href ? (
                <a
                  className={styles.creditLink}
                  href={credit.href}
                  title={credit.label}
                  dir="auto"
                  data-pane-label-hint={credit.label}
                >
                  {credit.label}
                </a>
              ) : (
                <span className={styles.creditFact} title={credit.label} dir="auto">
                  {credit.label}
                </span>
              )}
            </span>
          ))}
        </span>
      ))}
      {hiddenCreditCount > 0 ? (
        <span className={`${styles.fixed} ${styles.moreCredits}`}>
          <span aria-hidden="true">+{hiddenCreditCount}</span>
          <span className="sr-only">
            {hiddenCreditCount} more {pluralize("credit", hiddenCreditCount)}
          </span>
        </span>
      ) : null}
    </>
  );
}

interface ProjectedIdentity {
  /** Identity is still resolving — marked, never announced. */
  readonly pending: boolean;
  /** `null` drops the support line entirely rather than reserving space. */
  readonly support: ReactNode;
}

/** Plain support copy is one shrinkable, self-ellipsizing item of the row. */
function SupportText({ children }: { children: string }) {
  return <span className={styles.supportText}>{children}</span>;
}

function projectIdentity(
  model: PaneHeaderModel,
  projection: PaneHeaderProjection,
): ProjectedIdentity {
  switch (model.kind) {
    case "Section": {
      const pieces = [
        model.context.kind === "Present" ? model.context.value : null,
        formatMeta(model.meta),
      ].filter((piece): piece is string => piece !== null);
      return {
        pending: model.titlePending || model.meta.kind === "Pending",
        support:
          pieces.length > 0 ? (
            <SupportText>{pieces.join(" · ")}</SupportText>
          ) : null,
      };
    }
    case "Resource":
      switch (model.resource.status) {
        case "Pending":
          return {
            pending: true,
            support: <SupportText>{model.resource.accessibleLabel}</SupportText>,
          };
        case "Unavailable":
          return { pending: false, support: <SupportText>Unavailable</SupportText> };
        case "Failed":
          return {
            pending: false,
            support: <SupportText>Failed to load</SupportText>,
          };
        case "Ready":
          return {
            pending: false,
            support:
              model.resource.creditGroups.length > 0 ? (
                <Credits
                  groups={model.resource.creditGroups}
                  maxVisible={maxVisibleCredits(projection)}
                />
              ) : null,
          };
      }
  }
}

/**
 * The sole owner of pane identity markup: one route-level `<h1>` carrying the
 * exact, untruncated canonical title (CSS clips it; the DOM, the accessible
 * name, and the native title disclosure keep it whole) and at most one support
 * line beneath it.
 */
export default function PaneHeaderIdentity({
  id,
  model,
  projection,
}: PaneHeaderIdentityProps): ReactElement {
  const { pending, support } = projectIdentity(model, projection);

  // `dir="auto"` sits on the root, not the heading: the title is the first
  // strong text here, so the whole identity resolves to the title's script and
  // an RTL work never sits flush right above LTR-aligned support.
  return (
    <div
      className={styles.identity}
      data-pane-header-identity="true"
      aria-busy={pending || undefined}
      dir="auto"
    >
      <h1 id={id} className={styles.title} title={model.title}>
        {model.title}
      </h1>
      {support === null ? null : (
        <p className={styles.support} data-pane-header-support="true">
          {support}
        </p>
      )}
    </div>
  );
}
