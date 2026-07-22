import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { AddSeed } from "@/lib/launcher/model";
import {
  ADD_SESSION_MAX_ITEMS,
  acceptanceErrorMessage,
  acceptedMediaIds,
  couldNotSubscribeCount,
  createAddSessionState,
  draftItems,
  isAddSessionDirty,
  reduceAddSession,
  settledAcceptedItems,
  submitItemIds,
  type AddItem,
  type StagedAddItem,
} from "./addContentSessionModel";

describe("acceptanceErrorMessage", () => {
  it("keeps a pre-identity 5xx outcome unresolved", () => {
    expect(
      acceptanceErrorMessage(
        new ApiError(
          502,
          "E_UPSTREAM",
          "Temporary upstream failure",
          "request-one",
        ),
      ),
    ).toMatchObject({
      kind: "Unresolved",
      feedback: { severity: "warning" },
    });
  });

  it.each(["E_INVALID_RESPONSE", "E_UNKNOWN", "E_INTERNAL"])(
    "keeps same-system contract failure %s as a defect even at 500",
    (code) => {
      const error = new ApiError(500, code, "Malformed response");
      expect(acceptanceErrorMessage(error)).toEqual({ kind: "Defect", error });
    },
  );

  it("keeps a non-abort DOM transport failure unresolved", () => {
    expect(
      acceptanceErrorMessage(
        new DOMException("Network failed", "NetworkError"),
      ),
    ).toMatchObject({
      kind: "Unresolved",
      feedback: { severity: "warning" },
    });
  });
});

const research = { id: "library-research", name: "Research", color: "#0ea5e9" };
const archive = { id: "library-archive", name: "Archive", color: null };
const contentSeed: AddSeed = {
  kind: "Content",
  initialFocus: "Url",
  initialDestinations: [research],
};

function initial() {
  return createAddSessionState({ seed: contentSeed, sessionId: "session-1" });
}

function draft(id: string, url = `https://example.com/${id}`): StagedAddItem {
  return {
    kind: "Draft",
    id,
    source: { kind: "Url", url },
    destinations: [research],
    idempotencyKey: `key-${id}`,
  };
}

function accepted(id: string, mediaId = `media-${id}`): AddItem {
  return {
    kind: "Accepted",
    id,
    source: { kind: "Url", url: `https://example.com/${id}` },
    result: {
      mediaId,
      sourceAttemptId: `attempt-${id}`,
      sourceType: "generic_web_url",
      sourceAttemptStatus: "queued",
      idempotencyOutcome: "created",
      duplicate: false,
      processingStatus: "pending",
      ingestEnqueued: true,
    },
  };
}

describe("add content staging", () => {
  it("starts from the seed with one explicit empty representation", () => {
    expect(initial()).toMatchObject({
      sessionId: "session-1",
      branch: "Content",
      initialFocus: "Url",
      urlInput: { text: "" },
      items: [],
      defaultDestinations: [research],
      opmlDestinations: [research],
      opml: { kind: "Empty" },
      mutation: { kind: "Idle" },
    });
  });

  it("stages at the cap and atomically rejects overflow without clearing input", () => {
    const first = reduceAddSession(initial(), {
      kind: "StageItems",
      source: "Url",
      items: Array.from({ length: ADD_SESSION_MAX_ITEMS }, (_, index) =>
        draft(`item-${index}`),
      ),
    });
    const withInput = reduceAddSession(first, {
      kind: "SetUrlText",
      text: "https://example.com/overflow",
    });
    const overflow = reduceAddSession(withInput, {
      kind: "StageItems",
      source: "Url",
      items: [draft("overflow")],
    });

    expect(overflow.items).toHaveLength(ADD_SESSION_MAX_ITEMS);
    expect(overflow.urlInput.text).toBe("https://example.com/overflow");
    expect(overflow.urlInput.feedback?.title).toContain("20");
  });

  it("keeps file overflow atomic and reports it outside the URL field", () => {
    const full = reduceAddSession(initial(), {
      kind: "StageItems",
      source: "File",
      items: Array.from({ length: ADD_SESSION_MAX_ITEMS }, (_, index) =>
        draft(`item-${index}`),
      ),
    });
    const overflow = reduceAddSession(full, {
      kind: "StageItems",
      source: "File",
      items: [draft("overflow")],
    });

    expect(overflow.items).toHaveLength(ADD_SESSION_MAX_ITEMS);
    expect(overflow.intakeFeedback?.title).toContain("20");
    expect(overflow.urlInput.feedback).toBeUndefined();
  });

  it("moves all current Drafts with the default while preserving other states", () => {
    const staged = reduceAddSession(initial(), {
      kind: "StageItems",
      source: "Url",
      items: [draft("one"), draft("two")],
    });
    const resolved = reduceAddSession(staged, {
      kind: "ResolveItem",
      item: accepted("one"),
    });
    const moved = reduceAddSession(resolved, {
      kind: "SetDefaultDestinations",
      destinations: [archive],
    });

    expect(moved.defaultDestinations).toEqual([archive]);
    expect(draftItems(moved)).toMatchObject([
      { id: "two", destinations: [archive] },
    ]);
    expect(settledAcceptedItems(moved)).toHaveLength(1);
  });

  it("changes one Draft without changing the default or its peers", () => {
    const staged = reduceAddSession(initial(), {
      kind: "StageItems",
      source: "Url",
      items: [draft("one"), draft("two")],
    });
    const edited = reduceAddSession(staged, {
      kind: "SetItemDestinations",
      itemId: "one",
      destinations: [archive],
    });

    expect(edited.defaultDestinations).toEqual([research]);
    expect(draftItems(edited).map((item) => item.destinations)).toEqual([
      [archive],
      [research],
    ]);
  });
});

describe("add content submission state", () => {
  it("freezes only selected Draft intent and exposes ordered submit ids", () => {
    const staged = reduceAddSession(initial(), {
      kind: "StageItems",
      source: "Url",
      items: [draft("one"), draft("two")],
    });
    expect(submitItemIds(staged)).toEqual(["one", "two"]);

    const submitting = reduceAddSession(staged, {
      kind: "StartSubmission",
      itemIds: ["two"],
    });
    expect(submitting.mutation).toEqual({
      kind: "Running",
      operation: { kind: "Submit", itemIds: ["two"] },
    });
    expect(submitting.items).toMatchObject([
      { kind: "Draft", id: "one" },
      {
        kind: "Submitting",
        id: "two",
        intent: { idempotencyKey: "key-two", destinations: [research] },
      },
    ]);
  });

  it("restages a rejected or unresolved intent only with an explicit new key", () => {
    const intent = {
      source: { kind: "Url" as const, url: "https://example.com/one" },
      destinations: [research],
      idempotencyKey: "old-key",
    };
    for (const kind of ["Rejected", "AcceptanceUnresolved"] as const) {
      const state = {
        ...initial(),
        items: [
          {
            kind,
            id: "one",
            intent,
            feedback: { severity: "error" as const, title: "Not added" },
          },
        ],
      };
      const restaged = reduceAddSession(state, {
        kind: "RestageItem",
        itemId: "one",
        idempotencyKey: "new-key",
      });
      expect(restaged.items[0]).toMatchObject({
        kind: "Draft",
        idempotencyKey: "new-key",
        source: intent.source,
        destinations: intent.destinations,
      });
    }
  });

  it("removes rejected and unresolved local rows independently", () => {
    const intent = {
      source: { kind: "Url" as const, url: "https://example.com/one" },
      destinations: [research],
      idempotencyKey: "old-key",
    };
    const state = {
      ...initial(),
      items: [
        {
          kind: "Rejected" as const,
          id: "rejected",
          intent,
          feedback: { severity: "error" as const, title: "Not added" },
        },
        {
          kind: "AcceptanceUnresolved" as const,
          id: "unresolved",
          intent,
          feedback: { severity: "warning" as const, title: "Status unknown" },
        },
      ],
    };

    expect(
      reduceAddSession(state, { kind: "RemoveItem", itemId: "rejected" }).items,
    ).toMatchObject([{ kind: "AcceptanceUnresolved", id: "unresolved" }]);
    expect(
      reduceAddSession(state, { kind: "RemoveItem", itemId: "unresolved" })
        .items,
    ).toMatchObject([{ kind: "Rejected", id: "rejected" }]);
  });

  it("removes accepted-uncertain local tracking without rolling back media", () => {
    const state = {
      ...initial(),
      items: [
        {
          kind: "AcceptedUncertain" as const,
          id: "uncertain",
          intent: {
            source: {
              kind: "File" as const,
              file: new File(["pdf"], "paper.pdf", {
                type: "application/pdf",
              }),
              fileKind: "Pdf" as const,
            },
            destinations: [research],
            idempotencyKey: "upload-key",
          },
          mediaId: "media-uncertain",
          sourceAttemptId: "attempt-uncertain",
          feedback: { severity: "warning" as const, title: "Status unknown" },
        },
      ],
    };

    expect(
      reduceAddSession(state, { kind: "RemoveItem", itemId: "uncertain" }),
    ).toMatchObject({ items: [], membershipByMediaId: new Map() });
  });

  it("turns stopped submissions into same-key uncertainty and releases the gate", () => {
    const submitting = reduceAddSession(
      reduceAddSession(initial(), {
        kind: "StageItems",
        source: "Url",
        items: [draft("one")],
      }),
      { kind: "StartSubmission", itemIds: ["one"] },
    );
    const stopped = reduceAddSession(submitting, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(),
      startedSubmissionItemIds: new Set(["one"]),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.items[0]).toMatchObject({
      kind: "AcceptanceUnresolved",
      intent: { idempotencyKey: "key-one" },
    });
    expect(stopped.mutation).toEqual({ kind: "Idle" });
  });

  it("retains a settled peer when Stop interrupts the rest of a batch", () => {
    const started = reduceAddSession(
      reduceAddSession(initial(), {
        kind: "StageItems",
        source: "Url",
        items: [draft("one"), draft("two")],
      }),
      { kind: "StartSubmission", itemIds: ["one", "two"] },
    );
    const partial = reduceAddSession(started, {
      kind: "ResolveItem",
      item: accepted("one"),
    });
    const stopped = reduceAddSession(partial, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(),
      startedSubmissionItemIds: new Set(["one", "two"]),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.items).toMatchObject([
      { kind: "Accepted", id: "one", result: { mediaId: "media-one" } },
      {
        kind: "AcceptanceUnresolved",
        id: "two",
        intent: { idempotencyKey: "key-two" },
      },
    ]);
  });

  it("preserves upload-init identity when Stop lands after durable acceptance", () => {
    const fileDraft: StagedAddItem = {
      kind: "Draft",
      id: "file-one",
      source: {
        kind: "File",
        file: new File(["%PDF"], "paper.pdf", { type: "application/pdf" }),
        fileKind: "Pdf",
      },
      destinations: [research],
      idempotencyKey: "upload-key",
    };
    const submitting = reduceAddSession(
      reduceAddSession(initial(), {
        kind: "StageItems",
        source: "File",
        items: [fileDraft],
      }),
      { kind: "StartSubmission", itemIds: ["file-one"] },
    );
    const stopped = reduceAddSession(submitting, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map([
        ["file-one", { mediaId: "media-one", sourceAttemptId: "attempt-one" }],
      ]),
      startedSubmissionItemIds: new Set(["file-one"]),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId: "media-one",
      sourceAttemptId: "attempt-one",
      intent: { idempotencyKey: "upload-key" },
    });
  });

  it("preserves upload-init identity when Stop lands during same-key reconciliation", () => {
    const file = new File(["%PDF"], "paper.pdf", { type: "application/pdf" });
    const unresolved: AddItem = {
      kind: "AcceptanceUnresolved",
      id: "file-one",
      intent: {
        source: { kind: "File", file, fileKind: "Pdf" },
        destinations: [research],
        idempotencyKey: "upload-key",
      },
      feedback: { severity: "warning", title: "Status unknown" },
    };
    const reconciling = reduceAddSession(
      { ...initial(), items: [unresolved] },
      {
        kind: "StartMutation",
        operation: { kind: "ReconcileAcceptance", itemId: "file-one" },
      },
    );
    const stopped = reduceAddSession(reconciling, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map([
        ["file-one", { mediaId: "media-one", sourceAttemptId: "attempt-one" }],
      ]),
      startedSubmissionItemIds: new Set(),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.items[0]).toMatchObject({
      kind: "AcceptedUncertain",
      mediaId: "media-one",
      sourceAttemptId: "attempt-one",
      intent: { idempotencyKey: "upload-key" },
    });
    expect(stopped.mutation).toEqual({ kind: "Idle" });
  });

  it("does not lose known identity when an accepted-uncertain check is stopped", () => {
    const file = new File(["%PDF"], "paper.pdf", { type: "application/pdf" });
    const uncertain: AddItem = {
      kind: "AcceptedUncertain",
      id: "file-one",
      intent: {
        source: { kind: "File", file, fileKind: "Pdf" },
        destinations: [research],
        idempotencyKey: "upload-key",
      },
      mediaId: "media-one",
      sourceAttemptId: "attempt-one",
      feedback: { severity: "warning", title: "Status unknown" },
    };
    const reconciling = reduceAddSession(
      { ...initial(), items: [uncertain] },
      {
        kind: "StartMutation",
        operation: { kind: "ReconcileAcceptance", itemId: "file-one" },
      },
    );
    const stopped = reduceAddSession(reconciling, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(),
      startedSubmissionItemIds: new Set(),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.items[0]).toEqual(uncertain);
    expect(stopped.mutation).toEqual({ kind: "Idle" });
  });

  it("restores a queued submission that never crossed the request boundary", () => {
    const submitting = reduceAddSession(
      reduceAddSession(initial(), {
        kind: "StageItems",
        source: "Url",
        items: [draft("one")],
      }),
      { kind: "StartSubmission", itemIds: ["one"] },
    );
    const stopped = reduceAddSession(submitting, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(),
      startedSubmissionItemIds: new Set(),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.items[0]).toMatchObject({
      kind: "Draft",
      source: { kind: "Url", url: "https://example.com/one" },
      idempotencyKey: "key-one",
    });
  });

  it("projects membership Stop from queued, started, and succeeded request truth", () => {
    const command = { kind: "Add" as const, libraryId: research.id };
    const libraries = [
      {
        ...research,
        isInLibrary: false,
        canAdd: true,
        canRemove: false,
      },
    ];
    const state = {
      ...initial(),
      membershipByMediaId: new Map(
        ["queued", "started", "succeeded"].map((mediaId) => [
          mediaId,
          { kind: "Updating" as const, libraries, command },
        ]),
      ),
      mutation: {
        kind: "Running" as const,
        operation: {
          kind: "Membership" as const,
          command,
          mediaIds: ["queued", "started", "succeeded"],
        },
      },
    };

    const stopped = reduceAddSession(state, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(),
      startedSubmissionItemIds: new Set(),
      membershipProgressByMediaId: new Map([
        ["queued", { phase: "Queued", libraries, command }],
        ["started", { phase: "Started", libraries, command }],
        ["succeeded", { phase: "Succeeded", libraries, command }],
      ]),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.membershipByMediaId.get("queued")).toMatchObject({
      kind: "Ready",
      libraries: [{ isInLibrary: false }],
    });
    expect(stopped.membershipByMediaId.get("started")).toMatchObject({
      kind: "CommandFailed",
      feedback: { title: "Stopped" },
    });
    expect(stopped.membershipByMediaId.get("succeeded")).toMatchObject({
      kind: "Ready",
      libraries: [{ isInLibrary: true }],
    });
  });

  it("restores an unrelated membership read from Loading on Stop", () => {
    const previous = {
      kind: "Ready" as const,
      libraries: [
        {
          ...research,
          isInLibrary: true,
          canAdd: false,
          canRemove: true,
        },
      ],
    };
    const state = {
      ...initial(),
      membershipByMediaId: new Map([
        ["media-read", { kind: "Loading" as const, previous }],
      ]),
      mutation: {
        kind: "Running" as const,
        operation: { kind: "Submit" as const, itemIds: [] },
      },
    };

    const stopped = reduceAddSession(state, {
      kind: "StopMutation",
      acceptedUploadIdentityByItemId: new Map(),
      startedSubmissionItemIds: new Set(),
      membershipProgressByMediaId: new Map(),
      acceptanceFeedback: { severity: "warning", title: "Status unknown" },
      operationFeedback: { severity: "warning", title: "Stopped" },
    });

    expect(stopped.membershipByMediaId.get("media-read")).toEqual(previous);
  });
});

describe("session derivations and OPML isolation", () => {
  it("treats raw input and every non-settled row as dirty, but not accepted results", () => {
    expect(isAddSessionDirty(initial())).toBe(false);
    expect(
      isAddSessionDirty(
        reduceAddSession(initial(), { kind: "SetUrlText", text: " draft " }),
      ),
    ).toBe(true);
    expect(isAddSessionDirty({ ...initial(), items: [accepted("one")] })).toBe(
      false,
    );
    expect(
      isAddSessionDirty({
        ...initial(),
        items: [
          {
            kind: "Invalid",
            id: "bad",
            source: {
              kind: "File",
              name: "bad.txt",
              sizeBytes: 3,
              fileKind: "Unsupported",
            },
            feedback: { severity: "error", title: "Unsupported" },
          },
        ],
      }),
    ).toBe(true);
  });

  it("copies Content destinations into OPML and discards OPML-local state on Back", () => {
    const defaults = reduceAddSession(initial(), {
      kind: "SetDefaultDestinations",
      destinations: [archive],
    });
    const opened = reduceAddSession(defaults, { kind: "OpenOpml" });
    const edited = reduceAddSession(opened, {
      kind: "SetOpmlDestinations",
      destinations: [research],
    });
    const selected = reduceAddSession(edited, {
      kind: "SetOpml",
      opml: {
        kind: "Ready",
        file: new File(["<opml />"], "feeds.opml", { type: "application/xml" }),
      },
    });
    const back = reduceAddSession(selected, { kind: "BackToContent" });

    expect(opened.opmlDestinations).toEqual([archive]);
    expect(edited.defaultDestinations).toEqual([archive]);
    expect(back).toMatchObject({
      branch: "Content",
      opmlDestinations: [archive],
      opml: { kind: "Empty" },
    });
  });

  it("deduplicates accepted media identity and derives the OPML residual", () => {
    const state = {
      ...initial(),
      items: [accepted("one", "same"), accepted("two", "same")],
    };
    expect(acceptedMediaIds(state)).toEqual(["same"]);
    expect(
      couldNotSubscribeCount({
        total: 10,
        imported: 4,
        skipped_already_subscribed: 2,
        skipped_invalid: 1,
        errors: [],
      }),
    ).toBe(3);
  });
});
