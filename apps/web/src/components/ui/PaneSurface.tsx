import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import styles from "./PaneSurface.module.css";

// `<></>` is an element, so a truthy check would hide the empty slot: look through fragments.
function renders(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => {
    if (
      isValidElement<{ children?: ReactNode }>(child) &&
      child.type === Fragment
    )
      return renders(child.props.children);
    return child !== "";
  });
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
      {renders(brief) ? <div className={styles.brief}>{brief}</div> : null}
      {renders(toolbar) ? <div className={styles.stack}>{toolbar}</div> : null}
      {renders(state) ? <div className={styles.stack}>{state}</div> : null}
      {renders(children) ? (
        <div className={styles.content}>{children}</div>
      ) : renders(empty) ? (
        <div className={styles.empty} data-pane-empty="">
          {empty}
        </div>
      ) : null}
      {renders(footer) ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
