import type { Metadata } from "next";
import { Suspense } from "react";
import "@/lib/documentReader/documentReader.module.css";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { verifySession } from "@/lib/auth/dal";
import { loadRenderEnvironment } from "@/lib/renderEnvironment/server";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";
import "./media/[id]/media.module.css";
import AuthenticatedShell from "./AuthenticatedShell";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";
import styles from "./layout.module.css";

// The workspace host renders the only <title> (the active pane's label), so
// the tree emits no metadata title that could overwrite it.
export const metadata: Metadata = { title: null };

// Reader layout css is shell-critical: a lazily loaded media pane must never
// render unstyled (PDF.js requires its positioned container up front). Only
// local work runs above Suspense, so the skeleton is the first flush and the
// workspace streams in when its data root resolves. A same-segment error.tsx
// cannot catch its own layout, hence the client boundary.
export default async function AuthenticatedLayout() {
  await verifySession();
  const renderEnvironment = await loadRenderEnvironment();
  return (
    <AuthenticatedWorkspaceErrorBoundary>
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
        <PaneLoadingState label="Loading workspace…" announcement="None" />
      </main>
    </div>
  );
}

async function Workspace(props: { renderEnvironment: RenderEnvironment }) {
  const bootstrap = await loadWorkspaceBootstrap();
  return (
    <AuthenticatedShell {...bootstrap} renderEnvironment={props.renderEnvironment} />
  );
}
