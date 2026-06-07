import { Suspense } from "react";
import { verifySession } from "@/lib/auth/dal";
import { loadRenderEnvironment } from "@/lib/renderEnvironment/server";
import { AuthenticatedShellSkeleton } from "./AuthenticatedShellSkeleton";
import WorkspaceBootstrapGate from "./WorkspaceBootstrapGate";

// Only LOCAL work runs above the Suspense boundary — the auth gate (may redirect) and the
// header-derived render environment. The chrome skeleton is the first flush (TTFB depends on
// nothing networked); the data root resolves behind the boundary and streams in (S4 / R1).
export default async function AuthenticatedLayout() {
  await verifySession();
  const renderEnvironment = await loadRenderEnvironment();
  return (
    <Suspense fallback={<AuthenticatedShellSkeleton />}>
      <WorkspaceBootstrapGate renderEnvironment={renderEnvironment} />
    </Suspense>
  );
}
