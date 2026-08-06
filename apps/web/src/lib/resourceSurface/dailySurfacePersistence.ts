import { Fragment } from "prosemirror-model";
import {
  captureDailyPageNote,
  readDailyPage,
  type DailyCaptureResult,
} from "@/lib/notes/api";
import type { DailyDraft } from "@/lib/notes/dailyDraftStore";
import type {
  ResourceSurface,
  ResourceSurfaceOccurrence,
} from "@/lib/resources/resourceItems";
import type { PaneEntryDelivery } from "@/lib/workspace/targetActivation";
import {
  createNoteBodyDoc,
  noteBodySchema,
  noteBodyValueFromDoc,
} from "@/lib/notes/prosemirror/schema";
import type { MountedEditorMutationLease } from "@/lib/actions/mountedActionHandoff";

export interface DailySurfaceOwner {
  accountId: string;
  localDate: string;
}

export interface DailySurfaceSessionOptions {
  sessionKey: string;
  daily: DailySurfaceOwner;
  initialMaterialized?: {
    sourceRef: string;
    surface: ResourceSurface;
  };
  delivery?: PaneEntryDelivery | null;
  draftSnapshot?: DailyDraft | null;
  onDeliveryClaimed?: (
    delivery: PaneEntryDelivery,
    claimedNoteId: string,
  ) => void;
  beforePrepend?: (noteRef: string) => void;
  onError?: (error: unknown) => void;
  onTitleMutationStarted?: () => MountedEditorMutationLease | null;
  onSourceBodyMutationStarted?: () => MountedEditorMutationLease | null;
}

export type DailySurfaceLoad =
  | { kind: "Latent"; title: string }
  | {
      kind: "Materialized";
      pageId: string;
      sourceRef: string;
      title: string;
      surface: ResourceSurface;
    };

export async function loadDailySurface(
  owner: DailySurfaceOwner,
): Promise<DailySurfaceLoad> {
  const descriptor = await readDailyPage(owner.localDate);
  return descriptor.kind === "Latent"
    ? { kind: "Latent", title: descriptor.defaultTitle }
    : {
        kind: "Materialized",
        pageId: descriptor.page.id,
        sourceRef: `page:${descriptor.page.id}`,
        title: descriptor.page.title,
        surface: descriptor.surface,
      };
}

export async function captureDailySurface(
  owner: DailySurfaceOwner,
  draft: DailyDraft,
): Promise<DailyCaptureResult> {
  return captureDailyPageNote(owner.localDate, {
    clientMutationId: draft.clientMutationId,
    noteId: draft.noteId,
    bodyPmJson: draft.bodyPmJson,
  });
}

export function draftNoteRef(noteId: string): string {
  return `note_block:${noteId}`;
}

export function createDailyDraft(
  owner: DailySurfaceOwner,
  noteId: string,
  clientMutationId: string,
  bodyPmJson: Record<string, unknown> = { type: "paragraph" },
): DailyDraft {
  return {
    version: 1,
    ...owner,
    noteId,
    clientMutationId,
    bodyPmJson,
    bodyText: "",
    handoff: { kind: "None" },
  };
}

export type DailyDraftTextAppend =
  | { readonly kind: "Appended"; readonly draft: DailyDraft }
  | { readonly kind: "Unavailable" };

export function dailyDraftAcceptsText(draft: DailyDraft): boolean {
  return Boolean(
    createNoteBodyDoc({
      bodyPmJson: draft.bodyPmJson,
      fallbackBodyText: draft.bodyText,
    }).firstChild?.inlineContent,
  );
}

export function appendDailyDraftText(
  draft: DailyDraft,
  text: string,
): DailyDraftTextAppend {
  if (text.length === 0) return { kind: "Appended", draft };
  const doc = createNoteBodyDoc({
    bodyPmJson: draft.bodyPmJson,
    fallbackBodyText: draft.bodyText,
  });
  const body = doc.firstChild;
  if (!body?.inlineContent) return { kind: "Unavailable" };
  const content = body.content.append(Fragment.from(noteBodySchema.text(text)));
  const value = noteBodyValueFromDoc(
    noteBodySchema.nodes.note_body_doc!.create(
      null,
      body.type.create(body.attrs, content, body.marks),
    ),
  );
  return { kind: "Appended", draft: { ...draft, ...value } };
}

export function dailyDraftBodyChanged(
  previous: DailyDraft | null,
  next: DailyDraft,
): boolean {
  return (
    !previous ||
    previous.bodyText !== next.bodyText ||
    JSON.stringify(previous.bodyPmJson) !== JSON.stringify(next.bodyPmJson)
  );
}

export function pendingDailyBody(
  draft: DailyDraft,
  clientMutationId: string,
) {
  return {
    bodyPmJson: draft.bodyPmJson,
    bodyText: draft.bodyText,
    clientMutationId,
  };
}

export function surfaceContainsDailyDraft(
  surface: ResourceSurface,
  draft: DailyDraft | null,
): boolean {
  return Boolean(
    draft &&
      surface.orderedItems.some(
        (item) => item.target.item.ref === draftNoteRef(draft.noteId),
      ),
  );
}

export function provisionalDailyOccurrence(input: {
  occurrenceId: string;
  noteRef: string;
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
}): ResourceSurfaceOccurrence {
  const noteId = input.noteRef.slice("note_block:".length);
  return {
    occurrenceId: input.occurrenceId,
    target: {
      item: {
        ref: input.noteRef,
        scheme: "note_block",
        id: noteId,
        label: "",
        summary: "",
        route: `/notes/${noteId}`,
        activation: {
          resourceRef: input.noteRef,
          kind: "route",
          href: `/notes/${noteId}`,
          unresolvedReason: null,
        },
        missing: false,
        capabilities: {
          userRelation: {
            userLinkSource: false,
            userLinkTarget: "none",
            noteReferenceTarget: false,
          },
          sharing: "None",
          libraryPlacement: "None",
          attachable: false,
          chatSubject: "none",
          readable: "none",
          inspectable: "none",
          citableResultType: null,
          citationOutputSource: false,
          appSearchScope: false,
          conversationSearchScope: false,
          promptRender: "none",
          expansionPolicy: "none",
          expandable: false,
          adjacencySource: false,
          adjacencyTarget: false,
        },
        versionByLane: { body: 0, outgoing_edges: 0 },
      },
      content: {
        kind: "note_body",
        bodyPmJson: input.bodyPmJson,
        bodyText: input.bodyText,
      },
    },
  };
}
