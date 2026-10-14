import type { Metadata } from "next";
import { Suspense } from "react";
import "@/lib/documentReader/documentReader.module.css";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { verifySession } from "@/lib/auth/session";
import { loadRenderEnvironment } from "@/lib/renderEnvironment/server";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import type { EntryResult } from "@/lib/workspace/bootstrap";
import { isWorkspaceTransportError, loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";
import "./media/[id]/media.module.css";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";
import WorkspaceEntry from "./WorkspaceEntry";
import styles from "./layout.module.css";

// The workspace host renders the only <title> (the active pane's label), so
// the tree emits no metadata title that could overwrite it.
export const metadata: Metadata = { title: null };

// Reader layout css is shell-critical: a lazily loaded media pane must never
// render unstyled (PDF.js requires its positioned container up front). Only
// verified entry work runs above Suspense; the workspace skeleton precedes
// its required data and active seed. A same-segment error.tsx
// cannot catch its own layout, hence the client boundary.
export default async function AuthenticatedLayout() {
  const viewer = await verifySession();
  const renderEnvironment = await loadRenderEnvironment();
  return (
    <AuthenticatedWorkspaceErrorBoundary key={viewer.userId}>
      <Suspense fallback={<Skeleton collapsed={renderEnvironment.navCollapsed} />}>
        <Workspace renderEnvironment={renderEnvironment} />
      </Suspense>
    </AuthenticatedWorkspaceErrorBoundary>
  );
}

function Skeleton(props: { collapsed: boolean }) {
  return (
    <div className={styles.layout}>
      <title>Nexus</title>
      <div className={styles.rail} data-collapsed={props.collapsed || undefined} aria-hidden />
      <main className={styles.main}>
        <PaneLoadingState label="opening your workspace…" announcement="Polite" />
      </main>
    </div>
  );
}

async function Workspace(props: { renderEnvironment: RenderEnvironment }) {
  let result: EntryResult;
  try {
    result = { kind: "Ready", bootstrap: await loadWorkspaceBootstrap() };
  } catch (error) {
    if (!isWorkspaceTransportError(error)) throw error;
    result = { kind: "Unavailable", requestId: error.requestId };
  }
  return (
    <WorkspaceEntry result={result} renderEnvironment={props.renderEnvironment} />
  );
}
