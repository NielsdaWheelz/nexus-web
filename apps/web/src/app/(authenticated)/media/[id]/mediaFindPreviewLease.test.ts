import { describe, expect, it, vi } from "vitest";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";

describe("createMediaFindPreviewLease", () => {
  it("publishes one acquire/release transition and retires capture suppression", () => {
    const lease = createMediaFindPreviewLease();
    const changed = vi.fn();
    const unsubscribe = lease.subscribe(changed);

    lease.acquire();
    lease.acquire();
    expect(lease.isActive()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);

    lease.releaseForGenuineInput();
    lease.releaseForGenuineInput();
    expect(lease.isActive()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);

    lease.armNextCaptureSuppression();
    expect(lease.consumeNextCaptureSuppression(false)).toBe(true);
    expect(lease.consumeNextCaptureSuppression(false)).toBe(false);
    lease.armNextCaptureSuppression();
    expect(lease.consumeNextCaptureSuppression(true)).toBe(false);

    lease.acquire();
    lease.armNextCaptureSuppression();
    lease.retire();
    expect(lease.isActive()).toBe(true);
    expect(lease.consumeNextCaptureSuppression(false)).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
    lease.beginSource();
    expect(lease.isActive()).toBe(false);
    lease.acquire();
    expect(lease.isActive()).toBe(true);

    unsubscribe();
  });
});
