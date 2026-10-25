"use client";

import Button from "@/components/ui/Button";

// The pane shell owns placement; this accessory renders the published commands.
import { ArrowDown, ArrowUp, Check, IndentDecrease, IndentIncrease, Plus, Redo2, Undo2, type LucideIcon } from "lucide-react";
import type { PaneOutlineCommands } from "@/lib/panes/paneChrome";
import type { OutlineCommand } from "@/lib/notes/editorTypes";
import styles from "./OutlineCommands.module.css";

const commands: readonly [OutlineCommand, string, LucideIcon][] = [
  ["insert", "insert item", Plus],
  ["indent", "indent", IndentIncrease],
  ["outdent", "outdent", IndentDecrease],
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
        const commandLabel = command === "insert" ? publication.insertLabel : label;
        return (
          <Button
            key={command}
            iconOnly
            icon={<Icon size={18} aria-hidden="true" />}
            className={styles.command}
            size="comfortable"
            disabled={!state.enabled}
            tooltip={{text: state.reason ? `${commandLabel}: ${state.reason}` : commandLabel}}
            aria-label={commandLabel}
            onClick={() => {
              const active = current();
              if (active === publication && active.commandState(command).enabled)
                active.executeCommand(command);
            }}
          />
        );
      })}
      <Button
        iconOnly
        icon={<Check size={18} aria-hidden="true" />}
        className={styles.command}
        size="comfortable"
        aria-label="done"
        onClick={() => {
          if (current() === publication) publication.done();
        }}
      />
    </div>
  );
}
