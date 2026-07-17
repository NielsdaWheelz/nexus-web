import { loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import AuthenticatedShell from "./AuthenticatedShell";

// Streams in behind the layout's Suspense boundary: awaits the data root (required reader
// profile; best-effort session and pane seeds), then renders the client shell seeded with the
// restored workspace. Nothing here gates the first byte — the skeleton already flushed. A
// rejected bootstrap surfaces in AuthenticatedWorkspaceErrorBoundary.
export default async function WorkspaceBootstrapGate({
  renderEnvironment,
}: {
  renderEnvironment: RenderEnvironment;
}) {
  const { readerProfile, initialState, resources } = await loadWorkspaceBootstrap(
    renderEnvironment.androidShell
  );
  return (
    <AuthenticatedShell
      readerProfile={readerProfile}
      renderEnvironment={renderEnvironment}
      initialState={initialState}
      resources={resources}
    />
  );
}
