import type { Metadata } from "next";
import { Suspense } from "react";
import "@/components/PdfReader.module.css";
import { verifySession } from "@/lib/auth/dal";
import { loadRenderEnvironment } from "@/lib/renderEnvironment/server";
import "./media/[id]/page.module.css";
import { AuthenticatedShellSkeleton } from "./AuthenticatedShellSkeleton";
import { AuthenticatedWorkspaceErrorBoundary } from "./AuthenticatedWorkspaceErrorBoundary";
import WorkspaceBootstrapGate from "./WorkspaceBootstrapGate";

// The active pane's label is the browser title, and only the workspace host
// knows it. Dropping the inherited metadata title leaves the host's rendered
// <title> as the single title element in this tree: Next resolves a null title
// to no element at all, so its streamed metadata can no longer overwrite the
// pane identity with the generic app name.
export const metadata: Metadata = { title: null };

// Pane JavaScript stays lazy, but reader layout CSS is shell-critical. Next's
// runtime CSS hook resolves dynamic imports before their stylesheets commit;
// owning these small styles in the authenticated layout prevents a cached or
// preloaded media pane from rendering unstyled (and satisfies PDF.js's strict
// absolutely-positioned container precondition before its constructor runs).

// Only LOCAL work runs above the Suspense boundary — the auth gate (may redirect) and the
// header-derived render environment. The chrome skeleton is the first flush (TTFB depends on
// nothing networked); the data root resolves behind the boundary and streams in (S4 / R1).
// The client class boundary owns bootstrap failure (the required profile read): a
// same-segment error.tsx cannot catch its own layout.
export default async function AuthenticatedLayout() {
  await verifySession();
  const renderEnvironment = await loadRenderEnvironment();
  return (
    <AuthenticatedWorkspaceErrorBoundary>
      <Suspense fallback={<AuthenticatedShellSkeleton />}>
        <WorkspaceBootstrapGate renderEnvironment={renderEnvironment} />
      </Suspense>
    </AuthenticatedWorkspaceErrorBoundary>
  );
}
