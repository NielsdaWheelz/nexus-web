import { verifySession } from "@/lib/auth/dal";
import { loadWorkspaceBootstrap } from "@/lib/workspace/bootstrap.server";
import AuthenticatedShell from "./AuthenticatedShell";

export default async function AuthenticatedLayout() {
  await verifySession();
  const { initialHref, readerProfile, resources } = await loadWorkspaceBootstrap();
  return (
    <AuthenticatedShell
      initialHref={initialHref}
      readerProfile={readerProfile}
      resources={resources}
    />
  );
}
