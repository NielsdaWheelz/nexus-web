import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AddActivityDialog } from "./MediaPaneBody";

const ADJUSTMENT_HANDLE =
  "nca1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

afterEach(() => vi.unstubAllGlobals());

describe("manual Consumption activity", () => {
  it("retries one unchanged Add with stable replay identity", async () => {
    const requests: Array<{
      kind: string;
      clientMutationId: string;
      mediaRef: string;
      occurredAt: string;
      durationMs: number;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length === 1) throw new TypeError("offline");
        return new Response(
          JSON.stringify({
            data: {
              outcome: "Added",
              adjustmentHandle: {
                kind: "Present",
                value: ADJUSTMENT_HANDLE,
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const onAdded = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AddActivityDialog
        open
        mediaId="00000000-0000-4000-8000-000000000002"
        mediaKind="epub"
        returnFocusTo={null}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add time" }));
    expect(
      await screen.findByText("Reading state wasn’t changed"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add time" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      kind: "Add",
      mediaRef: "media:00000000-0000-4000-8000-000000000002",
      durationMs: 30 * 60_000,
    });
    expect(requests[1]).toEqual(requests[0]);
  });
});
