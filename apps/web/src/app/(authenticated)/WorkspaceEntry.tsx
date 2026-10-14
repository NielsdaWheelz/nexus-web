"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import { assertNever } from "@/lib/assertNever";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import type { EntryResult, WorkspaceBootstrap } from "@/lib/workspace/bootstrap";
import AuthenticatedShell from "./AuthenticatedShell";
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
      <main className={styles.error} role="alert" aria-labelledby="workspace-load-error-heading">
        <h1 id="workspace-load-error-heading">your workspace couldn’t load</h1>
        <p>try again to open it.</p>
        <Button onClick={() => window.location.reload()}>try again</Button>
      </main>
    );
  }
  return (
    <AuthenticatedShell
      {...bootstrap}
      renderEnvironment={renderEnvironment}
      entryFailure={result.kind === "Unavailable" ? result : null}
    />
  );
}
