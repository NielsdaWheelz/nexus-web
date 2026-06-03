"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type Ref,
  type SyntheticEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import LibraryColorDot from "@/components/LibraryColorDot";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";

export interface LibrarySummary {
  id: string;
  name: string;
  color?: string | null;
}

interface DropdownProps {
  mode: "dropdown";
  selectedLibraryIds: string[];
  onChange: (next: string[]) => void;
  libraries: LibrarySummary[];
  className?: string;
}

interface ModalProps {
  mode: "modal";
  selectedLibraryIds: string[];
  onChange: (next: string[]) => void;
  libraries: LibrarySummary[];
  open: boolean;
  onConfirm: (ids: string[]) => Promise<void> | void;
  onSkip: () => void;
  title?: string;
  className?: string;
}

type Props = DropdownProps | ModalProps;

const SEARCH_THRESHOLD = 6;
const EMPTY_TOOLTIP =
  "Create a library to file shared docs into multiple places.";
const MY_LIBRARY_ONLY = "My Library only";

const TRIGGER_LABEL_STYLE: CSSProperties = {
  overflow: "hidden",
  maxWidth: 180,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const PANEL_STYLE: CSSProperties = {
  zIndex: 1100,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  border: "1px solid var(--edge)",
  borderRadius: "var(--radius-lg)",
  background: "var(--surface-canvas)",
  boxShadow: "var(--shadow-3)",
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: "min(320px, calc(100vh - 200px))",
  overflowY: "auto",
};

const ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  width: "100%",
  minHeight: 42,
  padding: "8px 10px",
  border: "none",
  borderRadius: "var(--radius-lg)",
  background: "transparent",
  color: "var(--ink)",
  cursor: "pointer",
  textAlign: "left",
};

const ITEM_NAME_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
};

const EMPTY_STATE_STYLE: CSSProperties = {
  padding: "8px 10px",
  color: "var(--ink-faint)",
  fontSize: "var(--text-xs)",
};

const MODAL_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 8,
  paddingTop: 12,
  borderTop: "1px solid var(--edge-subtle)",
  marginTop: 12,
};

const MODAL_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 280,
};

const STYLE_BLOCK = `
.lib-multi-item:hover { background: var(--surface-hover); }
.lib-multi-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lib-multi-item[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
.lib-multi-trigger-label { font-weight: var(--weight-regular); }
.lib-multi-search-input { width: 100%; }
`;

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function computeChipLabel(
  selectedLibraryIds: string[],
  libraries: LibrarySummary[]
): string {
  if (selectedLibraryIds.length === 0) {
    return MY_LIBRARY_ONLY;
  }
  if (selectedLibraryIds.length === 1) {
    const match = libraries.find((lib) => lib.id === selectedLibraryIds[0]);
    return match ? `+ ${match.name}` : `+ 1 library`;
  }
  return `+ ${selectedLibraryIds.length} libraries`;
}

function filterLibraries(
  libraries: LibrarySummary[],
  query: string
): LibrarySummary[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return libraries;
  return libraries.filter((lib) =>
    lib.name.toLowerCase().includes(trimmed)
  );
}

function LibraryOption({
  library,
  checked,
  busy,
  onToggle,
}: {
  library: LibrarySummary;
  checked: boolean;
  busy?: boolean;
  onToggle: (id: string) => void;
}) {
  const activate = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle(library.id);
  };
  return (
    <div
      className="lib-multi-item"
      role="option"
      aria-selected={checked}
      aria-disabled={busy || undefined}
      tabIndex={busy ? -1 : 0}
      style={ITEM_STYLE}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        activate(event);
      }}
    >
      <span style={{ display: "flex", minWidth: 0 }}>
        <span style={ITEM_NAME_STYLE}>
          <LibraryColorDot color={library.color} />
          {library.name}
        </span>
      </span>
      <span
        role="checkbox"
        aria-checked={checked}
        aria-label={library.name}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          border: `1px solid ${checked ? "var(--accent)" : "var(--edge)"}`,
          borderRadius: "var(--radius-sm)",
          background: checked ? "var(--accent)" : "transparent",
          color: checked ? "var(--on-accent, white)" : "transparent",
          flexShrink: 0,
        }}
      >
        {checked ? <Check size={12} aria-hidden="true" /> : null}
      </span>
    </div>
  );
}

function LibraryOptionList({
  libraries,
  query,
  onQueryChange,
  selectedIds,
  onToggle,
  busy,
  inputRef,
}: {
  libraries: LibrarySummary[];
  query: string;
  onQueryChange: (next: string) => void;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  busy?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const showSearch = libraries.length > SEARCH_THRESHOLD;
  const filtered = showSearch ? filterLibraries(libraries, query) : libraries;
  return (
    <>
      {showSearch ? (
        <div style={{ display: "flex" }}>
          <Input
            ref={inputRef}
            type="search"
            value={query}
            className="lib-multi-search-input"
            placeholder="Search libraries..."
            aria-label="Search libraries"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      ) : null}

      <div
        style={LIST_STYLE}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Libraries"
      >
        {filtered.length === 0 ? (
          <div style={EMPTY_STATE_STYLE}>No libraries match.</div>
        ) : (
          filtered.map((library) => (
            <LibraryOption
              key={library.id}
              library={library}
              checked={selectedIds.has(library.id)}
              busy={busy}
              onToggle={onToggle}
            />
          ))
        )}
      </div>
    </>
  );
}

export default function LibraryMultiSelectPicker(props: Props) {
  if (props.mode === "modal") {
    return <ModalPicker {...props} />;
  }
  return <DropdownPicker {...props} />;
}

function DropdownPicker(props: DropdownProps) {
  const { selectedLibraryIds, onChange, libraries, className } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const {
    ref: panelRef,
    style: anchoredStyle,
    anchorRect,
  } = useAnchoredPosition(buttonRef.current, {
    enabled: open,
    placement: "below",
    align: "start",
    gap: 6,
  });

  const showSearch = libraries.length > SEARCH_THRESHOLD;
  const chipLabel = computeChipLabel(selectedLibraryIds, libraries);
  const selectedSet = useMemo(
    () => new Set(selectedLibraryIds),
    [selectedLibraryIds]
  );
  const isEmpty = libraries.length === 0;

  useDismissOnOutsideOrEscape({
    enabled: open,
    refs: [panelRef, buttonRef],
    onDismiss: (reason) => {
      setOpen(false);
      if (reason === "escape") {
        requestAnimationFrame(() => {
          buttonRef.current?.focus();
        });
      }
    },
  });

  useEffect(() => {
    if (!open || !showSearch) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [open, showSearch]);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(selectedLibraryIds.filter((existing) => existing !== id));
      return;
    }
    onChange(dedupe([...selectedLibraryIds, id]));
  };

  const panel =
    open && !isEmpty
      ? createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Select libraries"
            style={{
              ...PANEL_STYLE,
              ...anchoredStyle,
              width: Math.max(anchorRect?.width ?? 0, 260),
            }}
          >
            <LibraryOptionList
              libraries={libraries}
              query={query}
              onQueryChange={setQuery}
              selectedIds={selectedSet}
              onToggle={toggle}
              inputRef={inputRef}
            />
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <style>{STYLE_BLOCK}</style>
      <Button
        ref={buttonRef}
        variant="secondary"
        size="sm"
        className={className}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        disabled={isEmpty}
        title={isEmpty ? EMPTY_TOOLTIP : undefined}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          if (isEmpty) return;
          event.preventDefault();
          event.stopPropagation();
          if (!open) setQuery("");
          setOpen((current) => !current);
        }}
        trailingIcon={
          isEmpty ? undefined : <ChevronDown size={14} aria-hidden="true" />
        }
      >
        <span
          className="lib-multi-trigger-label"
          style={TRIGGER_LABEL_STYLE}
        >
          {chipLabel}
        </span>
      </Button>
      {panel}
    </>
  );
}

function ModalPicker(props: ModalProps) {
  const {
    selectedLibraryIds,
    onChange,
    libraries,
    open,
    onConfirm,
    onSkip,
    title = "Add to libraries",
  } = props;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedSet = useMemo(
    () => new Set(selectedLibraryIds),
    [selectedLibraryIds]
  );
  const isEmpty = libraries.length === 0;

  useEffect(() => {
    if (!open) {
      setQuery("");
      setBusy(false);
    }
  }, [open]);

  const toggle = (id: string) => {
    if (busy) return;
    if (selectedSet.has(id)) {
      onChange(selectedLibraryIds.filter((existing) => existing !== id));
      return;
    }
    onChange(dedupe([...selectedLibraryIds, id]));
  };

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm(selectedLibraryIds);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog open={open} onClose={onSkip} title={title}>
      <style>{STYLE_BLOCK}</style>
      <div style={MODAL_BODY_STYLE}>
        {isEmpty ? (
          <div style={EMPTY_STATE_STYLE}>{EMPTY_TOOLTIP}</div>
        ) : (
          <LibraryOptionList
            libraries={libraries}
            query={query}
            onQueryChange={setQuery}
            selectedIds={selectedSet}
            onToggle={toggle}
            busy={busy}
          />
        )}

        <div style={MODAL_FOOTER_STYLE}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            disabled={busy}
          >
            Skip
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            disabled={isEmpty}
            loading={busy}
          >
            Confirm
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
