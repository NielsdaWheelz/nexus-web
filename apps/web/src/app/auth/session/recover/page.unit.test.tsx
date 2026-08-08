import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionRecoveryPage from "./page";

describe("GET /auth/session/recover", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders without resolving or mutating a session", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);

    const page = await SessionRecoveryPage({
      searchParams: Promise.resolve({ next: "/media/748f7d1c" }),
    });

    expect(renderToStaticMarkup(page)).toContain("Restoring your session…");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
