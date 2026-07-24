"use client";

import LibraryEntryEditor, {
  type LibraryEntryEditorProps,
} from "@/components/libraries/LibraryEntryEditor";
import Dialog from "@/components/ui/Dialog";
import type { ReturnFocusTarget } from "@/lib/ui/useReturnFocus";

interface LibraryEntryPanelProps extends LibraryEntryEditorProps {
  open: boolean;
  title: string;
  onClose: () => void;
  returnFocusTo?: ReturnFocusTarget;
  returnFocusFallback?: ReturnFocusTarget;
}

// Add Content owns this desktop wrapper. Standing resource actions use the
// responsive LibraryPlacementOverlay instead.
export default function LibraryEntryPanel({
  open,
  title,
  onClose,
  returnFocusTo,
  returnFocusFallback,
  ...editorProps
}: LibraryEntryPanelProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      returnFocusTo={returnFocusTo}
      returnFocusFallback={returnFocusFallback}
    >
      <LibraryEntryEditor {...editorProps} />
    </Dialog>
  );
}
