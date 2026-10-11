import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSurface.module.css";

// `<></>` is an element, so a truthy check would hide the empty slot: look through fragments.
function renders(node: ReactNode): boolean {
  if (node === undefined || node === null || node === false) return false;
  if (
    isValidElement<{ children?: ReactNode }>(node) &&
    node.type === Fragment
  ) {
    return Children.toArray(node.props.children).some(renders);
  }
  return true;
}

/** A pane body's column: brief, toolbar, state, then the content or, when it renders nothing, `empty`. */
export default function PaneSurface({
  brief,
  toolbar,
  state,
  empty,
  footer,
  children,
  className,
}: {
  brief?: ReactNode;
  toolbar?: ReactNode;
  state?: ReactNode;
  empty?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(styles.surface, className)}>
      {brief ? <div className={styles.brief}>{brief}</div> : null}
      {toolbar ? <div className={styles.stack}>{toolbar}</div> : null}
      {state ? <div className={styles.stack}>{state}</div> : null}
      {renders(children) ? (
        <div className={styles.content}>{children}</div>
      ) : empty ? (
        <div className={styles.empty} data-pane-empty="">
          {empty}
        </div>
      ) : null}
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
