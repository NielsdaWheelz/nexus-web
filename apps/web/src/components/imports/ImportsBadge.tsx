"use client";

import Pill from "@/components/ui/Pill";
import { useImports } from "@/lib/imports/ImportsProvider";
import { importsBadge } from "./importsWorkspaceModel";

/**
 * The Imports destination's own label and attention badge, so the rail link and
 * the account menu item render one badge with one meaning (contract D9). The
 * visible count is capped; the accessible name carries the exact count and is
 * the whole name of the control this sits in.
 */
export default function ImportsBadge({ label }: { readonly label: string }) {
  const { summary } = useImports();
  const badge = importsBadge(summary);
  if (badge.kind === "Hidden") return <>{label}</>;
  return (
    <>
      <span aria-hidden="true">{label}</span>
      <Pill tone="warning" size="sm" aria-hidden="true">
        {badge.visible}
      </Pill>
      <span className="sr-only">{`${label}, ${badge.accessible}`}</span>
    </>
  );
}
