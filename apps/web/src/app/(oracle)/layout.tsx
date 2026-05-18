import type { ReactNode } from "react";
import { verifySession } from "@/lib/auth/dal";
import OracleShell from "./OracleShell";

export default async function OracleLayout({
  children,
}: {
  children: ReactNode;
}) {
  await verifySession();
  return <OracleShell>{children}</OracleShell>;
}
