/// <reference types="vite/client" />

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";

const senderModules = import.meta.glob<typeof import("./clientDefects")>(
  "./clientDefects.ts",
);
const boundaryModules = import.meta.glob<
  typeof import("@/components/workspace/PaneRouteErrorBoundary")
>("/src/components/workspace/PaneRouteErrorBoundary.tsx");

const originalSendBeacon = navigator.sendBeacon;
afterEach(() => {
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: originalSendBeacon,
  });
});

describe("client defect boundary", () => {
  it("contains a pane defect and reports one structural occurrence without private error material", async () => {
    const loadSender = senderModules["./clientDefects.ts"];
    const loadBoundary =
      boundaryModules["/src/components/workspace/PaneRouteErrorBoundary.tsx"];
    expect(loadSender).toBeTypeOf("function");
    expect(loadBoundary).toBeTypeOf("function");
    const { reportClientDefect, withClientDefectContext } = await loadSender();
    const { PaneRouteErrorBoundary } = await loadBoundary();
    const deliveries: Blob[] = [];
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: (_url: string, body: unknown) => {
        if (body instanceof Blob) deliveries.push(body);
        return true;
      },
    });
    const failure = withClientDefectContext(
      new ApiError(
        500,
        "E_INTERNAL",
        "SECRET_PROMPT token=PRIVATE",
        "request-proof",
      ),
      { phase: "Admission", commandId: "command-proof" },
    );
    function BrokenPane(): never {
      throw failure;
    }
    function View({ failed, active }: { failed: boolean; active: boolean }) {
      return (
        <>
          <label>
            Sibling draft
            <input />
          </label>
          <PaneRouteErrorBoundary
            paneId="pane-proof"
            visitId="visit-proof"
            resetKey="proof"
            slotMinWidth="0"
            isActive={active}
          >
            {failed ? <BrokenPane /> : <p>Pending pane</p>}
          </PaneRouteErrorBoundary>
        </>
      );
    }
    const view = render(<View failed={false} active={false} />);
    const sibling = screen.getByRole("textbox", { name: "Sibling draft" });
    await userEvent.fill(sibling, "Keep writing");
    view.rerender(<View failed={true} active={false} />);
    expect(await screen.findByText("This pane couldn’t load")).toBeVisible();
    expect(
      sibling,
      "An inactive pane defect stole sibling focus",
    ).toHaveFocus();
    await userEvent.keyboard(" here");
    expect(sibling).toHaveValue("Keep writing here");
    view.rerender(<View failed={true} active={true} />);
    expect(
      sibling,
      "Activation delivered obsolete pane-defect focus",
    ).toHaveFocus();
    reportClientDefect(failure, {
      scope: "Pane",
      paneId: "pane-proof",
      visitId: "visit-proof",
      componentStack: "duplicate",
    });
    await waitFor(() => expect(deliveries).toHaveLength(1));
    const wire = await deliveries[0].text();
    expect(wire).not.toContain("SECRET_PROMPT");
    expect(wire).not.toContain("PRIVATE");
    expect(JSON.parse(wire)).toMatchObject({
      pane_id: "pane-proof",
      visit_id: "visit-proof",
      phase: "Admission",
      command_id: { kind: "Present", value: "command-proof" },
      request_id: { kind: "Present", value: "request-proof" },
      error_code: "E_INTERNAL",
    });
    expect(JSON.parse(wire).component_stack).toContain("BrokenPane");
    expect(JSON.parse(wire)).not.toHaveProperty("release");
  });
  it("bounds a report and never recursively reports a failed sender", async () => {
    const loadSender = senderModules["./clientDefects.ts"];
    expect(loadSender).toBeTypeOf("function");
    const { reportClientDefect } = await loadSender();
    let attempts = 0;
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: () => {
        attempts += 1;
        throw new TypeError("Beacon unavailable");
      },
    });
    const failure = new Error("private");
    expect(() =>
      reportClientDefect(failure, {
        scope: "Pane",
      paneId: "pane",
        visitId: "visit",
        componentStack: "x".repeat(10000),
      }),
    ).not.toThrow();
    reportClientDefect(failure, {
      scope: "Pane",
      paneId: "pane",
      visitId: "visit",
      componentStack: "retry",
    });
    expect(attempts).toBe(1);
  });
});
