import type { ReactNode } from "react";
import OracleShell from "./OracleShell";

export default function OracleLayout({ children }: { children: ReactNode }) {
  return <OracleShell>{children}</OracleShell>;
}
