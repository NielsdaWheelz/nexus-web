"use client";

import { useState, type Ref } from "react";
import Button from "@/components/ui/Button";
import styles from "./DiscoveryTail.module.css";

/** A source's boundary stays keyboard reachable even if its last page supplied no rows. */
export default function DiscoveryTail({ boundary, label, action, busy, show }: {
  readonly boundary?: Ref<HTMLDivElement>;
  readonly label: string;
  readonly action: (() => void) | null;
  readonly busy: boolean;
  readonly show: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return <div ref={boundary}>
    {action !== null || focused ? <Button
      className={show ? undefined : styles.onFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-disabled={action === null || busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => { if (!busy) action?.(); }}
    >{label}</Button> : null}
  </div>;
}
