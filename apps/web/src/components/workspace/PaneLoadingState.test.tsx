import { render, screen } from "@testing-library/react";
import { cdp } from "vitest/browser";
import { describe, expect, it } from "vitest";
import "@/app/globals.css";
import { PaneLoadingState } from "./PaneLoadingState";

describe("PaneLoadingState", () => {
  it("announces a named initial pane load when requested", () => {
    render(<PaneLoadingState label="Loading library…" announcement="Polite" />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading library…");
  });

  it("keeps a named loading placeholder visual-only when its owner already announces", () => {
    render(<PaneLoadingState label="Loading library…" announcement="None" />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading library…")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("uses a static loading treatment when reduced motion is requested", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      render(
        <PaneLoadingState label="Loading library…" announcement="None" />,
      );
      const bar = screen.getByTestId("pane-loading-ink");

      expect(getComputedStyle(bar).animationName).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
    }
  });
});
