import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowserTimeZone } from "./browserTimeZone";

function Probe() {
  return <output aria-label="timezone">{useBrowserTimeZone()}</output>;
}

describe("useBrowserTimeZone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hydrates from the browser and refreshes on focus and pageshow", async () => {
    let timeZone = "America/Los_Angeles";
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      (() => ({ resolvedOptions: () => ({ timeZone }) })) as typeof Intl.DateTimeFormat,
    );
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByLabelText("timezone")).toHaveTextContent("America/Los_Angeles"),
    );
    timeZone = "Europe/Amsterdam";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(screen.getByLabelText("timezone")).toHaveTextContent("Europe/Amsterdam"),
    );
    timeZone = "Asia/Tokyo";
    window.dispatchEvent(new Event("pageshow"));
    await waitFor(() =>
      expect(screen.getByLabelText("timezone")).toHaveTextContent("Asia/Tokyo"),
    );
  });
});
