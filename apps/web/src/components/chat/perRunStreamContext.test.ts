import { describe, expect, it } from "vitest";
import { PerRunStreamContext } from "@/components/chat/perRunStreamContext";

describe("PerRunStreamContext", () => {
  it("tracks supersession tokens per run", () => {
    const ctx = new PerRunStreamContext();
    expect(ctx.currentToken("r1")).toBe(0);
    const token = ctx.currentToken("r1") + 1;
    ctx.claim("r1", token);
    expect(ctx.currentToken("r1")).toBe(1);
    expect(ctx.isSuperseded("r1", token)).toBe(false);
  });

  it("treats abort === null as not-streaming across the lifecycle", () => {
    const ctx = new PerRunStreamContext();
    ctx.claim("r1", 1);
    expect(ctx.isStreaming("r1")).toBe(false); // claimed but not yet streaming
    const abort = new AbortController();
    ctx.beginStream("r1", abort);
    expect(ctx.isStreaming("r1")).toBe(true);
    ctx.endStream("r1");
    expect(ctx.isStreaming("r1")).toBe(false);
    // Token survives the stream ending, so a re-tail still supersedes correctly.
    expect(ctx.currentToken("r1")).toBe(1);
  });

  it("abortAll aborts live streams, bumps every token, keeps the first-delta latch", () => {
    const ctx = new PerRunStreamContext();
    ctx.claim("r1", 1);
    ctx.claim("r2", 1);
    const abort1 = new AbortController();
    ctx.beginStream("r1", abort1);
    ctx.latchFirstDelta("r1");

    ctx.abortAll();

    expect(abort1.signal.aborted).toBe(true);
    expect(ctx.isStreaming("r1")).toBe(false);
    // Every known run's token is bumped (r2 had no live stream but still claims).
    expect(ctx.currentToken("r1")).toBe(2);
    expect(ctx.currentToken("r2")).toBe(2);
    // The first-delta latch is not reset by abortAll.
    expect(ctx.latchFirstDelta("r1")).toBe(false);
  });

  it("latchFirstDelta fires once per run", () => {
    const ctx = new PerRunStreamContext();
    expect(ctx.latchFirstDelta("r1")).toBe(true);
    expect(ctx.latchFirstDelta("r1")).toBe(false);
    expect(ctx.latchFirstDelta("r2")).toBe(true);
  });
});
