"use client";

import Button from "@/components/ui/Button";

// The pane shell owns placement; this accessory renders the published commands.
import { ArrowDown, ArrowUp, IndentDecrease, IndentIncrease, Redo2, Undo2, type LucideIcon } from "lucide-react";
import type { PaneOutlineCommands } from "@/lib/panes/paneChrome";
import type { OutlineCommand } from "@/lib/notes/editorTypes";
import styles from "./OutlineCommands.module.css";

const commands: readonly [OutlineCommand, string, LucideIcon][] = [
  ["outdent", "outdent", IndentDecrease],
  ["indent", "indent", IndentIncrease],
  ["move_up", "move item up", ArrowUp],
  ["move_down", "move item down", ArrowDown],
  ["undo", "undo", Undo2],
  ["redo", "redo", Redo2],
];

export default function OutlineCommands({
  publication,
  current,
}: {
  publication: PaneOutlineCommands;
  current(): PaneOutlineCommands | null;
}) {
  return (
    <div
      role="group"
      aria-label="outline commands"
      data-outline-commands={publication.session}
      className={styles.bar}
      onPointerDown={(event) => event.preventDefault()}
    >
      {commands.map(([command, label, Icon]) => {
        const state = publication.commandState(command);
        return (
          <Button
            key={command}
            iconOnly
            icon={<Icon size={18} aria-hidden="true" />}
            className={styles.command}
            size="comfortable"
            disabled={!state.enabled}
            tooltip={{text: state.reason ? `${label}: ${state.reason}` : label}}
            aria-label={label}
            onClick={() => {
              const active = current();
              if (active === publication && active.commandState(command).enabled)
                active.executeCommand(command);
            }}
          />
        );
      })}
    </div>
  );
}
