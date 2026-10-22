"use client";

import { useId } from "react";
import { Library, ListMinus, ListPlus, Pause, Play } from "lucide-react";
import Button from "@/components/ui/Button";
import { useMediaActions } from "@/lib/actions/useMediaActions";
import type { MediaSubject } from "@/lib/media/mediaSummary";
import type { PlayerDescriptor } from "@/lib/player/playerRuntime";
import styles from "./MediaActions.module.css";

const GLYPHS = { Library, ListMinus, ListPlus, Pause, Play };

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
  return (
    <div className={styles.actions} data-density={density}>
      {actions.map((action) => {
        const Glyph = GLYPHS[action.glyph];
        const reasonId = `${id}-${action.id}`;
        return (
          <span key={action.id} className={styles.control}>
            <Button
              iconOnly icon={<Glyph size={20} aria-hidden="true" />}
              tooltip={{ text: action.disabledReason ? `${action.label}: ${action.disabledReason}` : action.label }}
              className={styles.button} aria-label={action.label}
              aria-disabled={action.disabled || undefined} aria-busy={action.busy || undefined}
              aria-describedby={action.disabledReason ? reasonId : undefined}
              aria-haspopup={action.id === "LibraryPlacement" ? "dialog" : undefined}
              data-action-id={action.id} data-media-action=""
              onPointerDown={event => event.stopPropagation()}
              onKeyDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); action.invoke(event.currentTarget, returnFocus); }}
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
