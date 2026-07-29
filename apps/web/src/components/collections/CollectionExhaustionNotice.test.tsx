import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import CollectionExhaustionNotice from "./CollectionExhaustionNotice";

describe("CollectionExhaustionNotice", () => {
  it("uses one persistent polite announcement for a drain and completion", () => {
    const view = render(
      <CollectionExhaustionNotice
        state={{ kind: "Draining", loadedCount: 100 }}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading remaining items…");
    expect(
      screen
        .getAllByText("Loading remaining items…")
        .find((element) => !element.classList.contains("sr-only")),
    ).toBeVisible();

    view.rerender(
      <CollectionExhaustionNotice
        state={{ kind: "Draining", loadedCount: 200 }}
      />,
    );
    expect(screen.getAllByRole("status")).toEqual([status]);
    expect(status).toHaveTextContent("Loading remaining items…");

    view.rerender(
      <CollectionExhaustionNotice
        state={{ kind: "Complete", itemCount: 240 }}
      />,
    );
    expect(screen.getAllByRole("status")).toEqual([status]);
    expect(status).toHaveTextContent("Finished loading 240 items.");
    expect(screen.queryByText("Loading remaining items…")).toBeNull();
  });

  it("renders the exact retry notice and invokes its owned callback", async () => {
    const retry = vi.fn();
    render(
      <CollectionExhaustionNotice
        state={{
          kind: "ResumeFailed",
          error: new ApiError(503, "E_UPSTREAM", "down"),
          retry,
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Could not finish loading — Retry",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "CollectionChanged",
      "List changed while loading — Refresh list",
    ],
    [
      "InvalidCursor",
      "This list can no longer continue — Refresh list",
    ],
  ] as const)("renders exact %s recovery content", async (reason, text) => {
    const refresh = vi.fn();
    render(
      <CollectionExhaustionNotice
        state={{
          kind: "RefreshRequired",
          reason,
          error: new ApiError(409, "E_COLLECTION_CHANGED", "changed"),
          refresh,
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(text);
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh list" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
});
