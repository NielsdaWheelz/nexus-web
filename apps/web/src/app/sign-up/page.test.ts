import { beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((target: string): never => {
  throw new Error(`redirect:${target}`);
});

vi.mock("next/navigation", () => ({
  redirect,
}));

describe("/sign-up", () => {
  beforeEach(() => {
    vi.resetModules();
    redirect.mockClear();
  });

  async function renderSignUp(next?: string) {
    const { default: SignUpPage } = await import("./page");
    await SignUpPage({
      searchParams: Promise.resolve(next ? { next } : {}),
    });
  }

  it("redirects default sign-up traffic to create mode without next", async () => {
    await expect(renderSignUp()).rejects.toThrow(
      "redirect:/login?mode=create"
    );
    expect(redirect).toHaveBeenCalledWith("/login?mode=create");
  });

  it("preserves non-default return targets", async () => {
    await expect(renderSignUp("/browse")).rejects.toThrow(
      "redirect:/login?mode=create&next=%2Fbrowse"
    );
    expect(redirect).toHaveBeenCalledWith(
      "/login?mode=create&next=%2Fbrowse"
    );
  });

  it("drops unsafe return targets", async () => {
    await expect(renderSignUp("/..//evil.example")).rejects.toThrow(
      "redirect:/login?mode=create"
    );
    expect(redirect).toHaveBeenCalledWith("/login?mode=create");
  });
});
