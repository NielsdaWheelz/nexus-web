"use client";

import { useState } from "react";
import { FeedbackState } from "@/components/feedback/Feedback";
import { assertNever } from "@/lib/assertNever";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import type { EntryResult, WorkspaceBootstrap } from "@/lib/workspace/bootstrap";
import AuthenticatedShell from "./AuthenticatedShell";
import HostedPolicy from "@/lib/host/HostedPolicy";
import styles from "./layout.module.css";

/** One verified viewer's first successful initializer; later reads never replace live work. */
export default function WorkspaceEntry({
  result,
  renderEnvironment,
}: {
  result: EntryResult;
  renderEnvironment: RenderEnvironment;
}) {
  const incoming = result.kind === "Ready"
    ? result.bootstrap
    : result.kind === "Unavailable" ? null : assertNever(result);
  const [bootstrap, setBootstrap] = useState<WorkspaceBootstrap | null>(incoming);
  if (bootstrap === null && incoming !== null) {
    setBootstrap(incoming);
    return null;
  }
  if (bootstrap === null) {
    return (
      <main className={styles.error} aria-label="workspace unavailable">
        <FeedbackState
          content={{ tone: "Danger", title: "your workspace couldn’t load" }}
          announcement="Polite"
          actions={[{ label: "try again", onClick: () => window.location.reload() }]}
        />
      </main>
    );
  }
  return (
    <HostedPolicy><AuthenticatedShell
      {...bootstrap}
      renderEnvironment={renderEnvironment}
      entryFailure={result.kind === "Unavailable" ? result : null}
    /></HostedPolicy>
  );
}
