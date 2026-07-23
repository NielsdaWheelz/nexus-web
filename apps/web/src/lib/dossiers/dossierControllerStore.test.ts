import { afterEach, describe, expect, it, vi } from "vitest";
import { absent, present } from "@/lib/api/presence";
import { ApiError } from "@/lib/api/client";
import {
  openDossierBuildStream,
  type DossierSubjectDescriptor,
} from "@/lib/dossiers/generationAdapter";
import type { DossierStreamEvent } from "@/lib/dossiers/eventDecoder";
import type { DecodedDossierHead } from "@/lib/dossiers/dossierWire";
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
    const { store, streamArgs } = await attachedStore(decodedHead(false));
    const callbacks = streamArgs();
    if (!callbacks) throw new Error("expected stream callbacks");

    callbacks.onEvent({
      kind: "Succeeded",
      artifactRevisionRef: "artifact_revision:revision-1",
    } satisfies DossierStreamEvent);

    await vi.waitFor(() => expect(mocks.fetchHead).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot()).toMatchObject({
      stream: "Terminal",
      progressMessage: "Dossier generated.",
    });
    store.detach();
    expect(store.getSnapshot()).toMatchObject({
      stream: "Disconnected",
      progressMessage: null,
    });
    store.dispose();
  });
});
