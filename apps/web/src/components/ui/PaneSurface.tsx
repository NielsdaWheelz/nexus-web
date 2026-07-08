"use client";

import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSurface.module.css";

interface PaneSurfaceProps {
  opener?: ReactNode;
  toolbar?: ReactNode;
  state?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

// An empty fragment `<></>` is a valid element (an object), so a naive truthy
// check treats it as content and masks the `empty` slot. Look through fragments
// to their (booleans/nullish-stripped) children so a `<></>` reads as no
// content and the empty state survives.
function isRenderableContent(node: ReactNode): boolean {
  if (node === undefined || node === null || node === false) return false;
  if (isValidElement(node) && node.type === Fragment) {
    const kids = (node.props as { children?: ReactNode }).children;
    return Children.toArray(kids).some(isRenderableContent);
  }
  return true;
}

export default function PaneSurface({
  opener,
  toolbar,
  state,
  empty,
  footer,
  children,
  className,
}: PaneSurfaceProps) {
  const hasContent = isRenderableContent(children);

  return (
    <div className={cx(styles.surface, className)}>
      {opener ? <div className={styles.opener}>{opener}</div> : null}
      {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      {state ? <div className={styles.state}>{state}</div> : null}
      {hasContent ? (
        <div className={styles.content}>{children}</div>
      ) : empty ? (
        <div className={styles.empty}>{empty}</div>
      ) : null}
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
