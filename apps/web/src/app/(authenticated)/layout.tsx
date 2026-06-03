import { verifySession } from "@/lib/auth/dal";
import { loadRenderEnvironment } from "@/lib/renderEnvironment/server";
import { loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";
import AuthenticatedShell from "./AuthenticatedShell";

export default async function AuthenticatedLayout() {
  await verifySession();
  const { initialHref, readerProfile, resources } = await loadWorkspaceBootstrap();
  const renderEnvironment = await loadRenderEnvironment();
  return (
    <AuthenticatedShell
      initialHref={initialHref}
      readerProfile={readerProfile}
      renderEnvironment={renderEnvironment}
      resources={resources}
    />
  );
}
