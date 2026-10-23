"use client";

import { useId, useRef } from "react";
import { Library, ListMinus, ListPlus, Pause, Play } from "lucide-react";
import Button from "@/components/ui/Button";
import { useMediaActions } from "@/lib/actions/useMediaActions";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import styles from "./MediaActions.module.css";

export const MEDIA_ACTION_GLYPHS = { Library, ListMinus, ListPlus, Pause, Play };

/** Ordered media commands; execution and feedback belong to the account runtime. */
export default function MediaActions({
  subject,
  knownDescriptor,
  density,
  returnFocus,
}: {
  subject: MediaSubject;
  knownDescriptor: PlayerDescriptor | null;
  density: "Row" | "Header";
  returnFocus: () => HTMLElement | null;
}) {
  const actions = useMediaActions(subject, knownDescriptor);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useActionFocusRecovery(root, returnFocus);
  const title = subject.kind === "Stored" ? subject.summary.title : subject.title;
  return (
    <div ref={root} className={styles.actions} data-media-actions="" data-density={density}>
      {actions.map((action) => {
        const Glyph = MEDIA_ACTION_GLYPHS[action.glyph];
        const reasonId = `${id}-${action.id}`;
        const label = `${action.label}: ${title}`;
        return (
          <span key={action.id} className={styles.control} data-media-action-id={action.id}>
            <Button
              iconOnly
              icon={<Glyph />}
              className={styles.button}
              aria-label={label}
              aria-disabled={action.disabled || undefined}
              aria-busy={action.busy || undefined}
              aria-describedby={action.disabledReason ? reasonId : undefined}
              tooltip={{ text: action.disabledReason ? `${label}: ${action.disabledReason}` : label }}
              aria-haspopup={action.id === "LibraryPlacement" ? "dialog" : undefined}
              data-action-id={action.id}
              data-media-action=""
              onPointerDown={event => event.stopPropagation()}
              onKeyDown={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation();
                if (!action.disabled) action.invoke(event.currentTarget, returnFocus);
              }}
            />
            {action.disabledReason ? (
              <span className="sr-only" id={reasonId}>{action.disabledReason}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
