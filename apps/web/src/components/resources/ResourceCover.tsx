"use client";

import Artwork, { type ArtworkSource } from "@/components/ui/Artwork";
import Tooltip from "@/components/ui/Tooltip";
import type { ActionMenuContextAnchorProps } from "@/components/ui/ActionMenuHost";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import ContextualActionMenu from "./ContextualActionMenu";
import styles from "./ResourceCover.module.css";

/** A named cover link; an occurrence may offer one removal without taking over navigation. */
export default function ResourceCover({ href, title, label, source, removal, subjectKey, className }: {
  readonly href: string;
  readonly title: string;
  readonly label: string;
  readonly source: ArtworkSource;
  readonly removal?: ActionDescriptor;
  readonly subjectKey: string;
  readonly className?: string;
}) {
  const cover = (anchor: Partial<ActionMenuContextAnchorProps>) => <Tooltip text={title}
    disabled={anchor["aria-expanded"]} renderTrigger={tooltip => <a
      {...anchor} {...tooltip} href={href} aria-label={label} data-pane-label-hint={title}
      className={cx(styles.cover, className)}
      ref={node => {
        anchor.ref?.(node);
        const cleanup = tooltip.ref(node);
        if (node === null) return;
        return () => {
          anchor.ref?.(null);
          if (typeof cleanup === "function") cleanup();
          else tooltip.ref(null);
        };
      }}
      onPointerDown={event => { tooltip.onPointerDown(event); anchor.onPointerDown?.(event); }}
      onClickCapture={event => { anchor.onClickCapture?.(event); tooltip.onClickCapture(event); }}
    ><Artwork title={title} source={source} size="fill" /></a>} />;
  return removal ? <ContextualActionMenu title={title} subjectKey={subjectKey} navigation={null}
    sections={[{ id: "Occurrence", actions: [removal] }]} renderContextAnchor={cover} /> : cover({});
}
