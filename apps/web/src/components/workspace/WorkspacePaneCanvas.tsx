"use client";

import {
  Component,
  type ReactNode,
  type RefObject,
  type WheelEventHandler,
} from "react";
import styles from "./WorkspaceHost.module.css";

interface Props {
  readonly panes: readonly {
    readonly paneId: string;
    readonly visitId: string;
    readonly bodyKey: string;
    readonly isVisible: boolean;
  }[];
  readonly canvasRef: RefObject<HTMLDivElement | null>;
  readonly maximized: boolean;
  readonly onWheel: WheelEventHandler<HTMLDivElement>;
  readonly children: ReactNode;
}

interface ScrollSnapshot {
  readonly root: HTMLElement;
  readonly offsets: readonly {
    readonly element: HTMLElement;
    readonly top: number;
    readonly left: number;
  }[];
}

/** react's keyed dom moves reset descendant scroll offsets. capture before
 * mutation and restore before paint; reader navigation still owns its cursor.
 * a dom walk per affected layout change avoids coupling to each reader's dom. */
export default class WorkspacePaneCanvas extends Component<
  Props,
  Record<string, never>,
  readonly ScrollSnapshot[] | null
> {
  state = {};
  // hidden elements report zero offsets. keep their last visible offsets only
  // until reveal, and restore only if their pane order changed while hidden.
  private readonly hidden = new Map<
    string,
    ScrollSnapshot & { relocated: boolean }
  >();

  getSnapshotBeforeUpdate(previous: Props): readonly ScrollSnapshot[] | null {
    const panes = this.props.panes;
    const orderChanged = previous.panes.length !== panes.length ||
      previous.panes.some((pane, index) => pane.paneId !== panes[index]?.paneId);
    if (!orderChanged && previous.panes.every((pane, index) => {
      const next = panes[index];
      return pane.visitId === next.visitId && pane.bodyKey === next.bodyKey &&
        pane.isVisible === next.isVisible;
    })) return null;

    const canvas = this.props.canvasRef.current;
    if (!canvas) return null;
    const nextById = new Map(panes.map((pane) => [pane.paneId, pane]));
    const roots = new Map<string, HTMLElement>();
    for (const child of canvas.children) {
      if (child instanceof HTMLElement && child.dataset.paneId) {
        roots.set(child.dataset.paneId, child);
      }
    }
    const restore: ScrollSnapshot[] = [];
    for (const pane of previous.panes) {
      const next = nextById.get(pane.paneId);
      const root = roots.get(pane.paneId);
      if (!root || !next || pane.visitId !== next.visitId || pane.bodyKey !== next.bodyKey) {
        this.hidden.delete(pane.paneId);
        continue;
      }
      if (pane.isVisible) {
        if (next.isVisible && !orderChanged) continue;
        const offsets: ScrollSnapshot["offsets"][number][] = [];
        for (const element of root.querySelectorAll("*")) {
          if (!(element instanceof HTMLElement)) continue;
          const top = element.scrollTop;
          const left = element.scrollLeft;
          if (top !== 0 || left !== 0) offsets.push({ element, top, left });
        }
        if (next.isVisible) restore.push({ root, offsets });
        else this.hidden.set(pane.paneId, { root, offsets, relocated: orderChanged });
        continue;
      }
      const held = this.hidden.get(pane.paneId);
      if (!held) continue;
      if (held.root !== root) {
        this.hidden.delete(pane.paneId);
        continue;
      }
      if (orderChanged) held.relocated = true;
      if (next.isVisible) {
        this.hidden.delete(pane.paneId);
        if (held.relocated) restore.push(held);
      }
    }
    return restore;
  }

  componentDidUpdate(
    _previous: Props,
    _state: Record<string, never>,
    snapshot?: readonly ScrollSnapshot[] | null,
  ): void {
    if (!snapshot) return;
    for (const { root, offsets } of snapshot) {
      if (!root.isConnected || root.parentElement !== this.props.canvasRef.current) continue;
      for (const { element, top, left } of offsets) {
        if (root.contains(element)) element.scrollTo({ top, left, behavior: "instant" });
      }
    }
  }

  render() {
    return (
      <div
        ref={this.props.canvasRef}
        className={styles.paneCanvas}
        data-maximized={this.props.maximized || undefined}
        onWheel={this.props.onWheel}
      >
        {this.props.children}
      </div>
    );
  }
}
