import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MediaActivityProvider,
  useMediaActivity,
} from "./MediaActivityProvider";
import { publishMediaActivityInvalidation } from "./activityClient";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import { uploadIngestFile } from "@/lib/media/ingestionClient";

const UPLOAD_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_SESSION_HANDLE = "nup1.session.signature";

function activitySnapshot(needsAttentionCount: number, activeCount: number) {
  return {
    data: {
      needs_attention_count: needsAttentionCount,
      active_count: activeCount,
      has_more: needsAttentionCount + activeCount > 0,
      items: [],
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function Probe() {
  const {
    automaticRefreshEnded,
    beginActivityOpening,
    endActivityOpening,
    loadState,
    refreshActivity,
    refreshing,
    snapshot,
  } = useMediaActivity();
  const [manualSettlements, setManualSettlements] = useState(0);
  return (
    <>
      <output aria-label="Activity snapshot">
        {snapshot === null
          ? "Unknown"
          : `${snapshot.needsAttentionCount} attention, ${snapshot.activeCount} active`}
      </output>
      <output aria-label="Activity load state">{loadState.kind}</output>
      <output aria-label="Activity refresh state">
        {refreshing ? "Refreshing" : "Idle"}
      </output>
      <output aria-label="Activity automatic refresh">
        {automaticRefreshEnded ? "Ended" : "Available"}
      </output>
      <output aria-label="Activity manual refresh settlements">
        {manualSettlements}
      </output>
      <button
        type="button"
        onClick={() => {
          void refreshActivity().then(() =>
            setManualSettlements((count) => count + 1),
          );
        }}
      >
        Refresh Activity
      </button>
      <button type="button" onClick={beginActivityOpening}>
        Open Activity
      </button>
      <button type="button" onClick={endActivityOpening}>
        Close Activity
      </button>
    </>
  );
}

function renderProvider() {
  return render(
    <MediaActivityProvider>
      <Probe />
    </MediaActivityProvider>,
  );
}

describe("MediaActivityProvider convergence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs one non-overlapping trailing read when invalidated during a read", async () => {
    const blocked = deferred<Response>();
    const responses: Array<Response | Promise<Response>> = [
      jsonResponse(activitySnapshot(1, 0)),
      blocked.promise,
      jsonResponse(activitySnapshot(3, 0)),
    ];
    let activityReads = 0;
    let readsInFlight = 0;
    let maximumReadsInFlight = 0;
    vi.stubGlobal("fetch", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected Activity read");
      activityReads += 1;
      readsInFlight += 1;
      maximumReadsInFlight = Math.max(maximumReadsInFlight, readsInFlight);
      try {
        return await response;
      } finally {
        readsInFlight -= 1;
      }
    });

    renderProvider();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("1 attention, 0 active"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Refresh Activity" }),
    );
    await waitFor(() => expect(activityReads).toBe(2));
    publishMediaActivityInvalidation();
    blocked.resolve(jsonResponse(activitySnapshot(2, 1)));

    await waitFor(() => expect(activityReads).toBe(3));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("3 attention, 0 active"),
    );
    expect(maximumReadsInFlight).toBe(1);
  });

  it("makes a manual refresh during a read converge through one trailing read", async () => {
    const blocked = deferred<Response>();
    const responses: Array<Response | Promise<Response>> = [
      jsonResponse(activitySnapshot(1, 0)),
      blocked.promise,
      jsonResponse(activitySnapshot(3, 0)),
    ];
    let activityReads = 0;
    vi.stubGlobal("fetch", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected Activity read");
      activityReads += 1;
      return response;
    });

    renderProvider();
    await waitFor(() => expect(activityReads).toBe(1));

    await userEvent.click(
      screen.getByRole("button", { name: "Refresh Activity" }),
    );
    await waitFor(() => expect(activityReads).toBe(2));
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh Activity" }),
    );
    expect(
      screen.getByRole("status", {
        name: "Activity manual refresh settlements",
      }),
    ).toHaveTextContent("0");

    blocked.resolve(jsonResponse(activitySnapshot(2, 1)));
    await waitFor(() => expect(activityReads).toBe(3));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("3 attention, 0 active"),
    );
    expect(
      screen.getByRole("status", {
        name: "Activity manual refresh settlements",
      }),
    ).toHaveTextContent("2");
  });

  it("keeps the last good badge and ends its window when an automatic read fails", async () => {
    let activityReads = 0;
    vi.stubGlobal("fetch", async () => {
      activityReads += 1;
      if (activityReads === 1) {
        return jsonResponse(activitySnapshot(5, 1));
      }
      if (activityReads === 2) throw new TypeError("offline");
      throw new Error("Unexpected Activity read");
    });

    renderProvider();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("5 attention, 1 active"),
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Activity load state" }),
        ).toHaveTextContent("Failed"),
      { timeout: 6_500 },
    );
    expect(
      screen.getByRole("status", { name: "Activity snapshot" }),
    ).toHaveTextContent("5 attention, 1 active");
    expect(
      screen.getByRole("status", { name: "Activity automatic refresh" }),
    ).toHaveTextContent("Ended");
    expect(activityReads).toBe(2);
  });

  it("treats another tab and browser resume as wake hints for fresh snapshots", async () => {
    const responses = [
      jsonResponse(activitySnapshot(0, 0)),
      jsonResponse(activitySnapshot(4, 0)),
      jsonResponse(activitySnapshot(2, 0)),
    ];
    let activityReads = 0;
    vi.stubGlobal("fetch", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected Activity read");
      activityReads += 1;
      return response;
    });

    renderProvider();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("0 attention, 0 active"),
    );

    const otherTab = new BroadcastChannel("Media.ActivityInvalidated");
    otherTab.postMessage(null);
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("4 attention, 0 active"),
    );

    window.dispatchEvent(new Event("online"));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("2 attention, 0 active"),
    );
    expect(activityReads).toBe(3);
    otherTab.close();
  });

  it("broadcasts a placement-backed removal so another tab can clear its badge", async () => {
    const responses = [
      jsonResponse(activitySnapshot(2, 0)),
      jsonResponse(activitySnapshot(0, 0)),
    ];
    let activityReads = 0;
    vi.stubGlobal("fetch", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected Activity read");
      activityReads += 1;
      return response;
    });

    renderProvider();
    await waitFor(() => expect(activityReads).toBe(1));
    const otherTab = new BroadcastChannel("Media.ActivityInvalidated");
    let crossTabHints = 0;
    otherTab.addEventListener("message", () => {
      crossTabHints += 1;
    });

    publishLibraryPlacementChange("Unknown");
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("0 attention, 0 active"),
    );
    await waitFor(() => expect(crossTabHints).toBe(1));
    expect(activityReads).toBe(2);
    otherTab.close();
  });

  it("keeps foreground upload work out of Activity until publication", async () => {
    const signedUpload = deferred<Response>();
    let activityReads = 0;
    let signedUploadStarted = false;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/media/activity") {
          activityReads += 1;
          return jsonResponse(
            activitySnapshot(0, 0),
          );
        }
        if (url.pathname === "/api/media/uploads") {
          return jsonResponse({
            data: {
              kind: "UploadRequired",
              session_handle: UPLOAD_SESSION_HANDLE,
              generation: 1,
              method: "PUT",
              upload_url: "/signed-upload",
              required_headers: { "Content-Type": "application/pdf" },
              expires_at: new Date(Date.now() + 300_000).toISOString(),
              idempotency_outcome: "Created",
            },
          });
        }
        if (url.pathname === "/signed-upload" && init?.method === "PUT") {
          signedUploadStarted = true;
          return signedUpload.promise;
        }
        if (
          url.pathname ===
          `/api/media/uploads/${UPLOAD_SESSION_HANDLE}/confirm`
        ) {
          return jsonResponse({
            data: {
              kind: "Published",
              session_handle: UPLOAD_SESSION_HANDLE,
              media_id: UPLOAD_MEDIA_ID,
              source_attempt_id: UPLOAD_ATTEMPT_ID,
              idempotency_outcome: "Created",
            },
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    );

    renderProvider();
    await waitFor(() => expect(activityReads).toBe(1));
    const upload = uploadIngestFile({
      file: new File([new Uint8Array([1])], "accepted.pdf", {
        type: "application/pdf",
      }),
      libraryIds: [],
      idempotencyKey: "media-upload-acceptance-timing",
    });
    await waitFor(() => expect(signedUploadStarted).toBe(true));

    expect(
      screen.getByRole("status", { name: "Activity snapshot" }),
    ).toHaveTextContent("0 attention, 0 active");
    expect(activityReads).toBe(1);

    signedUpload.resolve(new Response(null, { status: 200 }));
    await expect(upload).resolves.toEqual({
      kind: "Published",
      result: {
        mediaId: UPLOAD_MEDIA_ID,
        sourceAttemptId: UPLOAD_ATTEMPT_ID,
        idempotencyOutcome: "created",
        duplicate: false,
      },
    });
    await waitFor(() => expect(activityReads).toBe(2));
  });

  it("polls known active work while closed and stops as soon as it completes", async () => {
    const responses = [
      jsonResponse(activitySnapshot(0, 1)),
      jsonResponse(activitySnapshot(0, 0)),
    ];
    let activityReads = 0;
    vi.stubGlobal("fetch", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected Activity read");
      activityReads += 1;
      return response;
    });

    renderProvider();
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("0 attention, 1 active"),
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "Activity snapshot" }),
        ).toHaveTextContent("0 attention, 0 active"),
      { timeout: 6_500 },
    );
    expect(activityReads).toBe(2);
  });

  it("starts a fresh read for each genuine opening after the mount observation", async () => {
    const responses = [
      jsonResponse(activitySnapshot(0, 0)),
      jsonResponse(activitySnapshot(1, 0)),
      jsonResponse(activitySnapshot(2, 0)),
    ];
    let activityReads = 0;
    vi.stubGlobal("fetch", async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected Activity read");
      activityReads += 1;
      return response;
    });

    renderProvider();
    await waitFor(() => expect(activityReads).toBe(1));

    await userEvent.click(
      screen.getByRole("button", { name: "Open Activity" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("1 attention, 0 active"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Close Activity" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open Activity" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Activity snapshot" }),
      ).toHaveTextContent("2 attention, 0 active"),
    );
    expect(activityReads).toBe(3);
  });
});
