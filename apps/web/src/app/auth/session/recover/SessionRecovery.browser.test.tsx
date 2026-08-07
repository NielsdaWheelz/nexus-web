import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAuthReturnTarget } from "@/lib/auth/redirects";
import SessionRecovery from "./SessionRecovery";

describe("session recovery surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes one automatic same-origin resolution attempt and offers an explicit retry on 503", async () => {
    const fetchStub = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchStub);

    render(<SessionRecovery nextPath={parseAuthReturnTarget("/media/123")} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't restore your session right now.",
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenLastCalledWith("/auth/session/resolve", {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Nexus-Session": "Resolve" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expect.poll(() => fetchStub.mock.calls.length).toBe(2);
  });
});
