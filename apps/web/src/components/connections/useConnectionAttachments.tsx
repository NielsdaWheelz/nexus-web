"use client";

import { useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import Button from "@/components/ui/Button";
import { useFeedback } from "@/components/feedback/Feedback";
import { useLinkComposerHost } from "@/lib/actions/ResourceActionsProvider";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { captureErrorFeedback } from "@/lib/imports/copy";
import { getFileUploadError, uploadIngestFile } from "@/lib/imports/ingest";

/** Upload-and-link belongs to the connection command, including chat admission. */
export function useConnectionAttachments(selfRef: string) {
  const feedback = useFeedback();
  const linkComposer = useLinkComposerHost();
  const [attaching, setAttaching] = useState(false);
  const attachingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  async function attachFiles(files: File[]) {
    if (attachingRef.current) return;
    attachingRef.current = true;
    setAttaching(true);
    try {
      for (const file of files) {
        const invalid = getFileUploadError(file);
        if (invalid) {
          feedback.offer({ key: "connection-attachment", announcement: "Polite", content: { tone: "Warning", title: "File wasn’t added", message: invalid } });
          continue;
        }
        let uploaded;
        try { uploaded = await uploadIngestFile({ file, libraryIds: [], id: crypto.randomUUID() }); }
        catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          feedback.offer({ key: `connection-upload:${selfRef}:${file.name}`, announcement: "Polite", content: captureErrorFeedback(error, "AddAttachment") });
          continue;
        }
        // The app-owned link session retains this saved media and frozen mutation
        // for retries after this pane closes. Undo removes only the link.
        await linkComposer.linkTo({ source: { kind: "resource", ref: selfRef }, sourceRef: selfRef, label: "saved file", target: { kind: "resource", ref: `media:${uploaded.mediaId}` }, targetLabel: file.name, savedFile: true });
      }
    } catch (error) { setDefect({ error }); }
    finally {
      attachingRef.current = false;
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }
  if (defect) throw defect.error;
  return {
    attaching,
    dropProps: {
      onDragOver: (event: React.DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); },
      onDrop: (event: React.DragEvent<HTMLElement>) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); event.stopPropagation(); void attachFiles(files); } },
    },
    control: <>
      <Button type="button" variant="ghost" size="sm" iconOnly loading={attaching} aria-label="Upload and link file" title="Upload and link file" onClick={() => fileInputRef.current?.click()}><Paperclip size={14} aria-hidden="true" /></Button>
      <input ref={fileInputRef} type="file" multiple hidden tabIndex={-1} onChange={(event) => void attachFiles(Array.from(event.currentTarget.files ?? []))} />
    </>,
  };
}
