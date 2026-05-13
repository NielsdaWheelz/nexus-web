import type { ReactNode } from "react";
import { requireAuthenticatedUser } from "@/lib/auth/protected";
import OracleShell from "./OracleShell";

export default async function OracleLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAuthenticatedUser();
  return <OracleShell>{children}</OracleShell>;
}
