import { describe, expect, it } from "vitest";
import {
  createRunVisibility,
  type RunVisibilityContext,
} from "@/lib/conversations/runVisibility";

const ctx: RunVisibilityContext = {
  conversationId: "c1",
  userMessageId: "u1",
  assistantMessageId: "a1",
};

describe("createRunVisibility", () => {
  it("isVisible defaults to true when no shouldApply is wired (linear mode)", () => {
    const v = createRunVisibility({ isMounted: () => true });
    expect(v.isVisible(ctx)).toBe(true);
  });

  it("isVisible delegates to shouldApply when present", () => {
    const onPath = createRunVisibility({
      isMounted: () => true,
      shouldApply: (c) => c.userMessageId === "u1",
    });
    expect(onPath.isVisible(ctx)).toBe(true);
    expect(onPath.isVisible({ ...ctx, userMessageId: "other" })).toBe(false);
  });

  it("canStart is false when unmounted regardless of shouldStart", () => {
    const v = createRunVisibility({
      isMounted: () => false,
      shouldStart: () => true,
    });
    expect(v.canStart(ctx)).toBe(false);
  });

  it("canStart defaults to true when mounted and no shouldStart is wired", () => {
    const v = createRunVisibility({ isMounted: () => true });
    expect(v.canStart(ctx)).toBe(true);
  });

  it("canStart requires both mounted and shouldStart", () => {
    const v = createRunVisibility({
      isMounted: () => true,
      shouldStart: (c) => c.conversationId === "c1",
    });
    expect(v.canStart(ctx)).toBe(true);
    expect(v.canStart({ ...ctx, conversationId: "elsewhere" })).toBe(false);
  });

  it("re-reads isMounted on each call (live ref semantics)", () => {
    let mounted = true;
    const v = createRunVisibility({ isMounted: () => mounted });
    expect(v.canStart(ctx)).toBe(true);
    mounted = false;
    expect(v.canStart(ctx)).toBe(false);
  });
});
