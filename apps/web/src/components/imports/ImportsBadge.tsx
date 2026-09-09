"use client";

import Pill from "@/components/ui/Pill";
import { useImports } from "@/lib/imports/ImportsProvider";
import { importsBadge } from "./importsWorkspaceModel";

/**
 * The Imports destination's own label and attention badge, so the rail link and
 * the account menu item render one badge with one meaning (contract D9). The
 * visible count is capped; the accessible name carries the exact count and is
 * the whole name of the control this sits in. `labelVisible` is false where the
 * chrome shows icons only (the collapsed rail): the count still paints, because
 * zero is the only condition that hides it.
 */
export default function ImportsBadge({
  label,
  labelVisible,
}: {
  readonly label: string;
  readonly labelVisible: boolean;
}) {
  const { summary } = useImports();
  const badge = importsBadge(summary);
  if (badge.kind === "Hidden") {
    return labelVisible ? <>{label}</> : <span className="sr-only">{label}</span>;
  }
  return (
    <>
      {labelVisible ? <span aria-hidden="true">{label}</span> : null}
      <Pill tone="warning" size="sm" aria-hidden="true">
        {badge.visible}
      </Pill>
      <span className="sr-only">{`${label}, ${badge.accessible}`}</span>
    </>
  );
}
