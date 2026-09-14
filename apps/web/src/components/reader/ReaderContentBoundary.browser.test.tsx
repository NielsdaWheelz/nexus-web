import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ReaderContentBoundary, { type ReaderContentDefect } from "./ReaderContentBoundary";

const originalSendBeacon = navigator.sendBeacon;
afterEach(() => {
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: originalSendBeacon });
});

function admitted() {
  return <button type="button">Pinned control</button>;
}

it("keeps admitted children and their focus across readiness changes", async () => {
  const view = render(<ReaderContentBoundary defect={null} ready={false} retry={() => {}}>{admitted()}</ReaderContentBoundary>);
  try {
    const pinned = await screen.findByRole("button", { name: "Pinned control" });
    pinned.focus();
    view.rerender(<ReaderContentBoundary defect={null} ready retry={() => {}}>{admitted()}</ReaderContentBoundary>);
    expect(screen.getByRole("button", { name: "Pinned control" }), "readiness remounted admitted children").toBe(pinned);
    expect(pinned, "readiness remount dropped keyboard focus").toHaveFocus();
    view.rerender(<ReaderContentBoundary defect={null} ready={false} retry={() => {}}>{admitted()}</ReaderContentBoundary>);
    expect(screen.getByRole("button", { name: "Pinned control" })).toBe(pinned);
    expect(pinned).toHaveFocus();
  } finally { view.unmount(); }
});

it("shows the read failure beside admitted children and alone before admission", async () => {
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => true });
  const defect: ReaderContentDefect = { key: "read:1", error: new Error("Read failed"), retry: () => {} };
  const view = render(<ReaderContentBoundary defect={defect} ready retry={() => {}}>{admitted()}</ReaderContentBoundary>);
  try {
    expect(await screen.findByText("The reader couldn’t load this part.")).toBeVisible();
    const pinned = screen.getByRole("button", { name: "Pinned control" });
    pinned.focus();
    view.rerender(<ReaderContentBoundary defect={defect} ready={false} retry={() => {}}>{admitted()}</ReaderContentBoundary>);
    expect(screen.getByText("The reader couldn’t load this part.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Pinned control" }), "a defect before admission left content below the notice").toBeNull();
    view.rerender(<ReaderContentBoundary defect={null} ready retry={() => {}}>{admitted()}</ReaderContentBoundary>);
    expect(screen.queryByText("The reader couldn’t load this part.")).toBeNull();
    expect(screen.getByRole("button", { name: "Pinned control" })).toBeVisible();
  } finally { view.unmount(); }
});
