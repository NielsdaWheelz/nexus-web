import { requireAuthenticatedUser } from "@/lib/auth/protected";
import AuthenticatedShell from "./AuthenticatedShell";

export default async function AuthenticatedLayout() {
  await requireAuthenticatedUser();
  return <AuthenticatedShell />;
}
