import { verifySession } from "@/lib/auth/dal";
import AuthenticatedShell from "./AuthenticatedShell";

export default async function AuthenticatedLayout() {
  await verifySession();
  return <AuthenticatedShell />;
}
