import { loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import AuthenticatedShell from "./AuthenticatedShell";

// Streams in behind the layout's Suspense boundary: awaits the data root (required account,
// reader profile and saved session; best-effort pane seeds), then renders the client shell with the
// restored workspace. Nothing here gates the first byte — the skeleton already flushed. A
// rejected bootstrap surfaces in AuthenticatedWorkspaceErrorBoundary.
export default async function WorkspaceBootstrapGate({
  renderEnvironment,
}: {
  renderEnvironment: RenderEnvironment;
}) {
  const { account, readerProfile, initialState, persistInitialState, resources } =
    await loadWorkspaceBootstrap();
  return (
    <AuthenticatedShell
      account={account}
      readerProfile={readerProfile}
      renderEnvironment={renderEnvironment}
      initialState={initialState}
      persistInitialState={persistInitialState}
      resources={resources}
    />
  );
}
