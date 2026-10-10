"use client";

// The annotation surfaces over the reader: the selection dock (Highlight with
// its colours, Note, Link, Ask, More), the quick note, a mark's action menu or
// a chooser where marks overlap, the colour dialog, the link dialog and the
// existing-chat picker.
import { useState } from "react";
import { Ellipsis, Highlighter, Link2, MessageCircleQuestion, NotebookPen } from "lucide-react";
import ConversationDestinationOverlay from "@/components/chat/ConversationDestinationOverlay";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import ResourceActionMenu from "@/components/resources/ResourceActionMenu";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import FloatingActionSurface from "@/components/ui/FloatingActionSurface";
import MobileSheet from "@/components/ui/MobileSheet";
import type { HighlightColor } from "@/lib/documentReader/model";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import type { AnnotationStore } from "./annotations";
import type { AnnotationVerbs } from "./useAnnotationVerbs";
import styles from "./media.module.css";

const COLOURS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];
const label = (color: string) => color[0].toUpperCase() + color.slice(1);

export function Colours({
  selected,
  onSelect,
}: {
  readonly selected: HighlightColor | null;
  readonly onSelect: (color: HighlightColor) => void;
}) {
  return (
    <div className={styles.colours}>
      {COLOURS.map((color) => (
        <button
          key={color}
          type="button"
          className={styles.colour}
          style={{ background: `var(--highlight-${color})` }}
          aria-label={selected === color ? `${label(color)} (selected)` : label(color)}
          aria-pressed={selected === color}
          disabled={selected === color}
          onClick={() => onSelect(color)}
        />
      ))}
    </div>
  );
}

export default function SelectionDock({
  verbs,
  store,
  isMobile,
  canQuote,
  onOpenLink,
}: {
  readonly verbs: AnnotationVerbs;
  readonly store: AnnotationStore;
  readonly isMobile: boolean;
  readonly canQuote: boolean;
  readonly onOpenLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
}) {
  const [colours, setColours] = useState(false);
  const { capture, menu, composer } = verbs;
  // A phone's targets are 44px.
  const size = isMobile ? "lg" : "sm";
  const dock = capture && !composer ? (
    <FloatingActionSurface
      open
      anchor={capture.rect}
      strategy="text-selection"
      preservePointerSelection
      onDismiss={() => {
        setColours(false);
        verbs.onSelection(null);
      }}
    >
      <div role="toolbar" aria-label="Selection actions" aria-busy={verbs.busy || undefined} className={styles.dock}>
        <Button
          variant="ghost"
          size={size}
          iconOnly
          aria-label="Highlight"
          title="Highlight"
          aria-haspopup="dialog"
          aria-expanded={colours}
          disabled={verbs.busy}
          onClick={() => setColours(!colours)}
        >
          <Highlighter size={16} aria-hidden="true" />
        </Button>
        <Button variant="ghost" size={size} iconOnly aria-label="Note" title="Note" disabled={verbs.busy} onClick={verbs.note}>
          <NotebookPen size={16} aria-hidden="true" />
        </Button>
        <Button variant="ghost" size={size} iconOnly aria-label="Link" title="Link" disabled={verbs.busy} onClick={verbs.linkSelection}>
          <Link2 size={16} aria-hidden="true" />
        </Button>
        {canQuote ? (
          <Button variant="ghost" size={size} iconOnly aria-label="Ask" title="Ask" disabled={verbs.busy} onClick={() => verbs.ask("new")}>
            <MessageCircleQuestion size={16} aria-hidden="true" />
          </Button>
        ) : null}
        <ActionMenu
          label="More"
          options={[
            { kind: "command", id: "learn", label: "Learn", onSelect: verbs.learn },
            ...(canQuote
              ? [{ kind: "command" as const, id: "ask-existing", label: "Ask in existing chat…", onSelect: () => verbs.ask("existing") }]
              : []),
            { kind: "command", id: "share", label: "Share", onSelect: ({ triggerEl }) => verbs.share(triggerEl) },
          ]}
          renderTrigger={(trigger) => (
            <Button {...trigger} variant="ghost" size={size} iconOnly title="More" disabled={verbs.busy}>
              <Ellipsis size={16} aria-hidden="true" />
            </Button>
          )}
        />
      </div>
      {colours ? (
        <div role="dialog" aria-label="Highlight colours" className={styles.colourDialog}>
          <Colours
            selected={null}
            onSelect={(color) => {
              setColours(false);
              verbs.highlight(color);
            }}
          />
        </div>
      ) : null}
    </FloatingActionSurface>
  ) : null;

  const editor = composer ? (
    <div className={styles.quickNote}>
      <blockquote>{composer.quote}</blockquote>
      <HighlightNoteEditor
        key={composer.key}
        target={
          composer.highlightId
            ? { kind: "highlight", id: composer.highlightId, ownerKey: `highlight:${composer.highlightId}` }
            : { kind: "highlight", id: null, ownerKey: `highlight-selection:${composer.key}`, creation: composer.creation ?? undefined }
        }
        note={null}
        editable
        onSaved={() => store.refresh()}
        onDetached={() => store.refresh()}
        onOpenLink={onOpenLink}
      />
      <Button size="sm" variant="ghost" onClick={verbs.closeComposer}>
        Done editing note
      </Button>
    </div>
  ) : null;

  const highlight = (id: string) => store.highlight(id);
  return (
    <>
      {dock}
      {editor && !isMobile ? (
        <FloatingActionSurface
          open
          anchor={composer!.rect}
          flip
          role="dialog"
          label="Add note to highlight"
          onDismiss={verbs.closeComposer}
        >
          {editor}
        </FloatingActionSurface>
      ) : null}
      <MobileSheet active={editor !== null && isMobile} onDismiss={verbs.closeComposer} ariaLabel="Add note to highlight" scrim="soft">
        {isMobile ? editor : null}
      </MobileSheet>
      {menu?.ids.length === 1 ? (
        <ResourceActionMenu
          key={`${menu.ids[0]}:${menu.rect.x}:${menu.rect.y}`}
          actionSubject={{ ref: canonicalResourceRef({ scheme: "highlight", id: menu.ids[0] }) }}
          label="Highlight actions"
          align="center"
          anchored={{ anchor: menu.rect, onDismiss: () => verbs.openMenu([], menu.rect) }}
        />
      ) : menu && menu.ids.length > 1 ? (
        <FloatingActionSurface open anchor={menu.rect} role="group" label="Highlights here" onDismiss={() => verbs.openMenu([], menu.rect)}>
          <div className={styles.chooser}>
            {menu.ids.map((id) => (
              <button key={id} type="button" onClick={() => verbs.openMenu([id], menu.rect)}>
                {highlight(id)?.quote ?? "Highlight"}
              </button>
            ))}
          </div>
        </FloatingActionSurface>
      ) : null}
      <Dialog open={verbs.recolouring !== null} title="Edit highlight" onClose={() => verbs.recolour(null)}>
        <Colours
          selected={verbs.recolouring ? (highlight(verbs.recolouring)?.color ?? null) : null}
          onSelect={verbs.recolour}
        />
      </Dialog>
      <ConversationDestinationOverlay
        open={verbs.choosingChat !== null}
        onClose={() => verbs.chat(null)}
        onSelectConversation={verbs.chat}
      />
    </>
  );
}
