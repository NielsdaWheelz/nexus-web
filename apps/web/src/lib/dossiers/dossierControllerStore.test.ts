import { afterEach, describe, expect, it, vi } from "vitest";
import { absent, present } from "@/lib/api/presence";
import { ApiError } from "@/lib/api/client";
import {
  openDossierBuildStream,
  type DossierSubjectDescriptor,
} from "@/lib/dossiers/generationAdapter";
import type { DossierStreamEvent } from "@/lib/dossiers/eventDecoder";
import type { DecodedDossierHead } from "@/lib/dossiers/dossierWire";
import type { DossierRevision } from "@/lib/dossiers/dossierControllerTypes";
import { createDossierControllerStore } from "@/lib/dossiers/dossierControllerStore";

const mocks = vi.hoisted(() => ({
  cancelBuild: vi.fn(),
  createBuild: vi.fn(),
  fetchHead: vi.fn(),
  fetchRevision: vi.fn(),
  fetchRevisions: vi.fn(),
  makeCurrent: vi.fn(),
  openStream: vi.fn(),
}));

vi.mock("@/lib/dossiers/generationAdapter", () => ({
  cancelDossierBuild: mocks.cancelBuild,
  createDossierBuild: mocks.createBuild,
  fetchDossierHead: mocks.fetchHead,
  fetchDossierRevision: mocks.fetchRevision,
  fetchDossierRevisions: mocks.fetchRevisions,
  makeDossierRevisionCurrent: mocks.makeCurrent,
  openDossierBuildStream: mocks.openStream,
}));

const SUBJECT: DossierSubjectDescriptor = {
  scheme: "conversation",
  handle: "conversation-1",
};

function decodedHead(active: boolean): DecodedDossierHead {
  return {
    artifactId: present("artifact-1"),
    artifactRef: present("artifact:artifact-1"),
    currentRevision: absent(),
    freshness: absent(),
    activeBuild: active
      ? present({
          handle: "build-handle-1",
          requesterUserId: absent(),
          instruction: absent(),
          createdAt: "2026-07-23T00:00:00Z",
          execution: present({ phase: "Running" }),
          failure: absent(),
          cancellation: absent(),
        })
      : absent(),
    latestUnsuccessfulBuild: absent(),
    revisionCount: 0,
    mediaAbstract: absent(),
  };
}

function historicalRevision(): DossierRevision {
  return {
    artifactId: "artifact-1",
    artifactRef: "artifact:artifact-1",
    revisionId: "revision-old",
    revisionRef: "artifact_revision:revision-old",
    isCurrent: false,
    contentMd: "# Historical dossier",
    citations: [],
    inputManifest: {
      version: "v1",
      kind: "conversation",
      conversationRef: "conversation:conversation-1",
      messageRefs: [],
      contextRefs: [],
      topologyFingerprint: absent(),
      completeness: { kind: "Complete" },
    },
    instruction: absent(),
    creatorUserId: absent(),
    modelProvider: absent(),
    modelName: absent(),
    totalTokens: absent(),
    createdAt: "2026-07-23T00:00:00Z",
    promotedAt: absent(),
  };
}

function decodedSuccessfulHead(): DecodedDossierHead {
  return {
    ...decodedHead(false),
    currentRevision: present({
      ...historicalRevision(),
      revisionId: "revision-1",
      revisionRef: "artifact_revision:revision-1",
      isCurrent: true,
    }),
    freshness: present("Current"),
    revisionCount: 1,
  };
}

type OpenStreamArgs = Parameters<typeof openDossierBuildStream>[1];

async function attachedStore(nextHead?: DecodedDossierHead) {
  let streamArgs: OpenStreamArgs | null = null;
  mocks.fetchHead.mockResolvedValueOnce(decodedHead(true));
  if (nextHead) mocks.fetchHead.mockResolvedValueOnce(nextHead);
  mocks.openStream.mockImplementation(
    async (_handle: string, args: OpenStreamArgs) => {
      streamArgs = args;
      return () => {};
    },
  );
  const store = createDossierControllerStore(SUBJECT);
  store.attach();
  await vi.waitFor(() => {
    expect(store.getSnapshot().head.kind).toBe("Ready");
    expect(mocks.openStream).toHaveBeenCalledOnce();
  });
  return {
    store,
    streamArgs: () => streamArgs,
  };
}

describe("createDossierControllerStore", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("suppresses only BuildNotActive cancellation races and reconciles the head", async () => {
    mocks.cancelBuild.mockRejectedValueOnce(
      new ApiError(
        409,
        "E_DOSSIER_BUILD_NOT_ACTIVE",
        "Build already terminal.",
      ),
    );
    const { store } = await attachedStore(decodedHead(false));

    store.cancel();

    await vi.waitFor(() => expect(mocks.fetchHead).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot().pendingAction).toBeNull();
    expect(store.getSnapshot().actionError).toBeNull();
    store.dispose();
  });

  it("surfaces every other cancellation API failure without pretending it reconciled", async () => {
    mocks.cancelBuild.mockRejectedValueOnce(
      new ApiError(500, "E_INTERNAL", "Cancellation service unavailable."),
    );
    const { store } = await attachedStore();

    store.cancel();

    await vi.waitFor(() => expect(store.getSnapshot().pendingAction).toBeNull());
    expect(mocks.fetchHead).toHaveBeenCalledOnce();
    expect(store.getSnapshot().actionError).toEqual({
      code: "E_INTERNAL",
      message: "Cancellation service unavailable.",
    });
    store.dispose();
  });

  it("retains a success announcement across the authoritative head refresh", async () => {
    const { store, streamArgs } = await attachedStore(decodedSuccessfulHead());
    const callbacks = streamArgs();
    if (!callbacks) throw new Error("expected stream callbacks");

    callbacks.onEvent({
      kind: "Succeeded",
      artifactRevisionRef: "artifact_revision:revision-1",
    } satisfies DossierStreamEvent);

    await vi.waitFor(() => expect(mocks.fetchHead).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot()).toMatchObject({
      stream: {
        kind: "Terminal",
        outcome: { kind: "Succeeded" },
        reconciled: true,
      },
      progressMessage: "Dossier generated.",
    });
    store.detach();
    expect(store.getSnapshot()).toMatchObject({
      stream: { kind: "Disconnected" },
      progressMessage: null,
    });
    store.dispose();
  });

  it.each([
    {
      label: "succeeded",
      event: {
        kind: "Succeeded",
        artifactRevisionRef: "artifact_revision:revision-1",
      } satisfies DossierStreamEvent,
      expected: {
        kind: "Succeeded",
        artifactRevisionRef: "artifact_revision:revision-1",
      },
    },
    {
      label: "failed",
      event: {
        kind: "Failed",
        facts: {
          failureCode: "ProviderIncomplete",
          detail: absent(),
          support: absent(),
        },
      } satisfies DossierStreamEvent,
      expected: {
        kind: "Failed",
        buildHandle: "build-handle-1",
        facts: {
          failureCode: "ProviderIncomplete",
          detail: absent(),
          support: absent(),
        },
      },
    },
    {
      label: "cancelled",
      event: {
        kind: "Cancelled",
        facts: {
          actor: absent(),
          at: "2026-07-23T01:00:00Z",
        },
      } satisfies DossierStreamEvent,
      expected: {
        kind: "Cancelled",
        buildHandle: "build-handle-1",
        facts: {
          actor: absent(),
          at: "2026-07-23T01:00:00Z",
        },
      },
    },
  ])(
    "retains the typed $label terminal outcome when its head reconciliation fails",
    async ({ event, expected }) => {
      const { store, streamArgs } = await attachedStore();
      const callbacks = streamArgs();
      if (!callbacks) throw new Error("expected stream callbacks");
      mocks.fetchHead.mockRejectedValueOnce(new TypeError("offline"));

      callbacks.onEvent(event);
      await vi.waitFor(() => expect(mocks.fetchHead).toHaveBeenCalledTimes(2));

      expect(store.getSnapshot()).toMatchObject({
        stream: {
          kind: "Terminal",
          outcome: expected,
          reconciled: false,
        },
        head: {
          kind: "Ready",
          ready: { activeBuild: { kind: "Present" } },
        },
      });
      store.dispose();
    },
  );

  it("retains historical selection across a Dossier tab detach and reattach", async () => {
    const { store } = await attachedStore(decodedHead(true));
    mocks.fetchRevision.mockResolvedValueOnce(historicalRevision());

    store.selectHistorical("artifact_revision:revision-old");
    await vi.waitFor(() =>
      expect(store.getSnapshot().historicalRevision.kind).toBe("Ready"),
    );
    store.detach();
    store.attach();
    await vi.waitFor(() => expect(mocks.fetchHead).toHaveBeenCalledTimes(2));

    expect(store.getSnapshot().revisionSelection).toEqual({
      kind: "Historical",
      revisionRef: "artifact_revision:revision-old",
    });
    store.dispose();
  });

  it("exposes reconnecting and settles on disconnected when fatal recovery cannot refetch", async () => {
    const { store, streamArgs } = await attachedStore();
    const callbacks = streamArgs();
    if (!callbacks) throw new Error("expected stream callbacks");

    await callbacks.onReconnect?.(1);
    expect(store.getSnapshot().stream).toEqual({ kind: "Reconnecting" });

    mocks.fetchHead.mockRejectedValueOnce(new TypeError("offline"));
    callbacks.onError(new Error("stream exhausted"));
    await vi.waitFor(() => expect(mocks.fetchHead).toHaveBeenCalledTimes(2));

    expect(store.getSnapshot().stream).toEqual({ kind: "Disconnected" });
    expect(store.getSnapshot().head).toMatchObject({
      kind: "Ready",
      ready: { activeBuild: { kind: "Present" } },
    });
    store.dispose();
  });
});
