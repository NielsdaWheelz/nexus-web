"use client";

import Button from "@/components/ui/Button";

// The pane shell owns placement; this accessory renders the published commands.
import * as Icon from "@/lib/ui/icons";
import type { PaneOutlineCommands } from "@/lib/panes/paneChrome";
import type { OutlineCommand } from "@/lib/notes/editorTypes";
import styles from "./OutlineCommands.module.css";

const commands: readonly [OutlineCommand, string, Icon.Glyph][] = [
  ["outdent", "Outdent", Icon.Outdent],
  ["indent", "Indent", Icon.Indent],
  ["move_up", "Move item up", Icon.MoveUp],
  ["move_down", "Move item down", Icon.MoveDown],
  ["undo", "Undo", Icon.Undo],
  ["redo", "Redo", Icon.Redo],
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
      {commands.map(([command, label, Glyph]) => {
        const state = publication.commandState(command);
        return (
          <Button
            key={command}
            iconOnly
            icon={<Glyph aria-hidden="true" />}
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
