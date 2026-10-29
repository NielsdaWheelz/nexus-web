"use client";

import {FeedbackFailure} from "@/components/feedback/Feedback";
import {useWritingDocumentRead} from "@/lib/notes/hooks";
import {isAuthoredStorageFailure, type WritingDocument} from "@/lib/notes/runtime";

/** Local storage failures have a real read retry; invariant defects retain their boundary. */
export default function AuthoredReadFailure({error, occurrence, retry, pending = false, title = "couldn’t refresh this note"}: {
  error: unknown | null; occurrence: object | null; retry(): void; pending?: boolean; title?: string;
}) {
  if (error === null) return null;
  if (!isAuthoredStorageFailure(error)) throw error;
  if (occurrence === null) throw new Error("failed authored read has no occurrence");
  return <FeedbackFailure scope="Local" occurrence={occurrence} content={{tone: "Warning", title}}
    announcement="Polite" actions={[{label: "retry", onClick: retry, busy: pending}]}/>;
}

export function DocumentReadFailure({document, title}: {document: WritingDocument; title?: string}) {
  const read = useWritingDocumentRead(document);
  return <AuthoredReadFailure {...read} pending={read.retrying} retry={document.retryRead} title={title}/>;
}
