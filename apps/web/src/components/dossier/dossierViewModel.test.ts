import { describe, expect, it } from "vitest";
import { present, absent } from "@/lib/api/presence";
import { initialDossierControllerState } from "@/lib/dossiers/dossierControllerTypes";
import type {
  DossierBuildSummary,
  DossierControllerState,
  DossierHeadReady,
  DossierRevision,
} from "@/lib/dossiers/dossierControllerTypes";
import { deriveDossierViewModel } from "@/components/dossier/dossierViewModel";

function revision(overrides: Partial<DossierRevision> = {}): DossierRevision {
  return {
    artifactId: "a1",
    artifactRef: "artifact:a1",
    revisionId: "r1",
    revisionRef: "artifact_revision:r1",
    isCurrent: true,
    contentMd: "# Dossier",
    citations: [],
    inputManifest: {
      version: "v1",
      kind: "media",
      mediaRef: "media:m1",
      contentFingerprint: "f1",
      offeredClaimCount: 1,
      omittedEvidenceRefs: [],
    },
    instruction: absent(),
    creatorUserId: absent(),
    modelProvider: absent(),
    modelName: absent(),
    totalTokens: absent(),
    createdAt: "2026-07-22T00:00:00Z",
    promotedAt: absent(),
    ...overrides,
  };
}

function build(overrides: Partial<DossierBuildSummary> = {}): DossierBuildSummary {
  return {
    handle: "h1",
    requesterUserId: absent(),
    instruction: absent(),
    createdAt: "2026-07-22T00:00:00Z",
    execution: absent(),
    failure: absent(),
    cancellation: absent(),
    ...overrides,
  };
}

function ready(overrides: Partial<DossierHeadReady> = {}): DossierControllerState {
  return {
    ...initialDossierControllerState(),
    head: {
      kind: "Ready",
      ready: {
        artifactId: present("a1"),
        artifactRef: present("artifact:a1"),
        currentRevision: absent(),
        freshness: absent(),
        activeBuild: absent(),
        latestUnsuccessfulBuild: absent(),
        revisionCount: 0,
        mediaAbstract: absent(),
        history: [],
        historyStatus: "idle",
        ...overrides,
      },
    },
  };
}

describe("deriveDossierViewModel — exhaustive A15 states", () => {
  it("head Loading → HeadLoading, no controls", () => {
    const vm = deriveDossierViewModel({
      ...initialDossierControllerState(),
      head: { kind: "Loading" },
    });
    expect(vm.body.kind).toBe("HeadLoading");
    expect(vm.controls.canGenerate).toBe(false);
  });

  it("never generated → Generate offered", () => {
    const vm = deriveDossierViewModel(ready());
    expect(vm.body.kind).toBe("NeverGenerated");
    expect(vm.controls.canGenerate).toBe(true);
    expect(vm.controls.canRetry).toBe(false);
  });

  it("current revision, no active build → Regenerate offered", () => {
    const vm = deriveDossierViewModel(
      ready({ currentRevision: present(revision()), freshness: present("Current"), revisionCount: 1 }),
    );
    expect(vm.body.kind).toBe("Revision");
    expect(vm.controls.canRegenerate).toBe(true);
    expect(vm.controls.canGenerate).toBe(false);
    expect(vm.alert).toBeNull();
    expect(vm.historyStatus).toBe("idle");
  });

  it("preserves revision-history loading and failure states", () => {
    expect(
      deriveDossierViewModel(
        ready({ revisionCount: 2, historyStatus: "loading" }),
      ).historyStatus,
    ).toBe("loading");
    expect(
      deriveDossierViewModel(
        ready({ revisionCount: 2, historyStatus: "failed" }),
      ).historyStatus,
    ).toBe("failed");
  });

  it("stale current revision surfaces freshness=Stale", () => {
    const vm = deriveDossierViewModel(
      ready({ currentRevision: present(revision()), freshness: present("Stale"), revisionCount: 1 }),
    );
    expect(vm.body).toMatchObject({ kind: "Revision", freshness: "Stale" });
  });

  it("active build over a current revision → regenerating + Cancel, no Generate", () => {
    const vm = deriveDossierViewModel(
      ready({
        currentRevision: present(revision()),
        activeBuild: present(build({ execution: present({ phase: "Running" }) })),
        revisionCount: 1,
      }),
    );
    expect(vm.activity).toMatchObject({ kind: "Building", regenerating: true });
    expect(vm.controls.canCancel).toBe(true);
    expect(vm.controls.canRegenerate).toBe(false);
    expect(vm.statusMessage).not.toBeNull();
  });

  it("suspended active build → Cancel only, Generate/Retry unavailable", () => {
    const vm = deriveDossierViewModel(
      ready({ activeBuild: present(build({ execution: present({ phase: "Suspended" }) })) }),
    );
    expect(vm.activity.kind).toBe("Suspended");
    expect(vm.controls.canCancel).toBe(true);
    expect(vm.controls.canGenerate).toBe(false);
    expect(vm.controls.canRetry).toBe(false);
  });

  it("terminal failure (no current) → alert + Retry, no Generate", () => {
    const vm = deriveDossierViewModel(
      ready({
        latestUnsuccessfulBuild: present(
          build({ failure: present({ failureCode: "ProviderRefused", detail: absent(), support: absent() }) }),
        ),
      }),
    );
    expect(vm.activity).toMatchObject({ kind: "Failed", code: "ProviderRefused" });
    expect(vm.alert).toMatchObject({ retry: true });
    expect(vm.controls.canRetry).toBe(true);
    expect(vm.controls.canGenerate).toBe(false);
  });

  it("failure never removes a preserved current revision", () => {
    const vm = deriveDossierViewModel(
      ready({
        currentRevision: present(revision()),
        revisionCount: 1,
        latestUnsuccessfulBuild: present(
          build({ failure: present({ failureCode: "InputsChanged", detail: absent(), support: absent() }) }),
        ),
      }),
    );
    expect(vm.body.kind).toBe("Revision");
    expect(vm.alert).not.toBeNull();
  });

  it("cancelled latest build → Cancelled activity", () => {
    const vm = deriveDossierViewModel(
      ready({
        latestUnsuccessfulBuild: present(
          build({ cancellation: present({ actor: absent(), at: "2026-07-22T00:00:00Z" }) }),
        ),
      }),
    );
    expect(vm.activity.kind).toBe("Cancelled");
  });

  it("keeps the terminal success announcement after the refreshed revision lands", () => {
    const vm = deriveDossierViewModel({
      ...ready({
        currentRevision: present(revision()),
        revisionCount: 1,
      }),
      stream: "Terminal",
      progressMessage: "Dossier generated.",
    });

    expect(vm.activity.kind).toBe("Idle");
    expect(vm.statusMessage).toBe("Dossier generated.");
  });

  it("historical selection with Ready revision → Make current, view-only", () => {
    const state: DossierControllerState = {
      ...ready({ currentRevision: present(revision()), revisionCount: 2 }),
      revisionSelection: { kind: "Historical", revisionRef: "artifact_revision:r0" },
      historicalRevision: {
        kind: "Ready",
        revision: revision({ revisionId: "r0", revisionRef: "artifact_revision:r0", isCurrent: false }),
      },
    };
    const vm = deriveDossierViewModel(state);
    expect(vm.body).toMatchObject({ kind: "Revision", provenance: "historical" });
    expect(vm.controls.canMakeCurrent).toBe(true);
    expect(vm.makeCurrentTargetRef).toBe("artifact_revision:r0");
  });
});
