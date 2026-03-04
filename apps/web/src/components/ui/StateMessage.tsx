import type { ReactNode } from "react";
import styles from "./StateMessage.module.css";

type StateVariant = "loading" | "empty" | "error" | "success" | "info";

interface StateMessageProps {
  variant: StateVariant;
  children: ReactNode;
}

export default function StateMessage({ variant, children }: StateMessageProps) {
  const role = variant === "error" ? "alert" : "status";

  return (
    <div className={`${styles.message} ${styles[variant]}`} role={role}>
      {children}
    </div>
  );
}
