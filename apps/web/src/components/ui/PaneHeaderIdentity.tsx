import type { ReactNode } from "react";
import type {
  PaneHeaderCreditGroup,
  PaneHeaderModel,
} from "@/lib/panes/paneHeaderModel";
import styles from "./PaneHeaderIdentity.module.css";

function plural(unit: string, count: number): string {
  if (count === 1) return unit;
  if (/(s|x|z|ch|sh)$/.test(unit)) return `${unit}es`;
  if (/[^aeiou]y$/.test(unit)) return `${unit.slice(0, -1)}ies`;
  return `${unit}s`;
}

/**
 * The pane's identity: its one `<h1>`, carrying the whole title (css clips it;
 * the dom, the accessible name and the native tooltip keep it), and at most one
 * support line. `dir="auto"` sits on the root so an rtl title aligns its support too.
 */
export default function PaneHeaderIdentity({
  id,
  model,
  projection,
}: {
  readonly id: string;
  readonly model: PaneHeaderModel;
  readonly projection: "Desktop" | "Mobile";
}) {
  let pending = false;
  let support: ReactNode = null;
  if (model.kind === "Section") {
    const context =
      model.context !== null ? [model.context] : [];
    const meta =
      model.meta.kind === "Count"
        ? [
            `${model.meta.value.toLocaleString()} ${plural(model.meta.unit, model.meta.value)}`,
          ]
        : model.meta.kind === "Subscription"
          ? [model.meta.subscribed ? "subscribed" : "not subscribed"]
          : [];
    const pieces = [...context, ...meta];
    pending = model.meta.kind === "Pending";
    support =
      pieces.length > 0 ? (
        <span className={styles.supportText}>{pieces.join(" · ")}</span>
      ) : null;
  } else {
    const { resource } = model;
    pending = resource.status === "Pending";
    if (resource.status !== "Ready") {
      const text =
        resource.status === "Pending"
          ? resource.accessibleLabel
          : resource.status === "Unavailable"
            ? "Unavailable"
            : "Failed to load";
      support = <span className={styles.supportText}>{text}</span>;
    } else if (resource.creditGroups.length > 0) {
      support = (
        <Credits
          groups={resource.creditGroups}
          max={projection === "Desktop" ? 2 : 1}
        />
      );
    }
  }
  return (
    <div
      className={styles.identity}
      aria-busy={pending || undefined}
      dir="auto"
    >
      <h1 id={id} className={styles.title} title={model.title}>
        {model.title}
      </h1>
      {support === null ? null : <p className={styles.support}>{support}</p>}
    </div>
  );
}

/** Credits fill the line from the front up to `max`; the rest are counted, never listed. */
function Credits({
  groups,
  max,
}: {
  groups: readonly PaneHeaderCreditGroup[];
  max: number;
}) {
  let room = max;
  const shown = groups.flatMap((group) => {
    if (room === 0) return [];
    const credits = group.credits.slice(0, room);
    room -= credits.length;
    return [{ group, credits }];
  });
  const hidden =
    groups.reduce((count, group) => count + group.credits.length, 0) -
    (max - room);
  return (
    <>
      {shown.map(({ group, credits }, index) => (
        <span
          key={group.kind === "Authors" ? "Authors" : `${group.label}-${index}`}
          className={styles.group}
        >
          {index > 0 ? <span className={styles.fixed}> · </span> : null}
          {group.kind === "Authors" ? (
            <span className="sr-only">Authors: </span>
          ) : (
            <span className={styles.fixed}>{group.label}: </span>
          )}
          {credits.map((credit, creditIndex) => (
            <span
              key={`${credit.label}-${creditIndex}`}
              className={styles.group}
            >
              {creditIndex > 0 ? (
                <span className={styles.fixed}>, </span>
              ) : null}
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
                <span className={styles.credit} title={credit.label} dir="auto">
                  {credit.label}
                </span>
              )}
            </span>
          ))}
        </span>
      ))}
      {hidden > 0 ? (
        <span className={`${styles.fixed} ${styles.moreCredits}`}>
          <span aria-hidden="true">+{hidden}</span>
          <span className="sr-only">
            {hidden} more {plural("credit", hidden)}
          </span>
        </span>
      ) : null}
    </>
  );
}
