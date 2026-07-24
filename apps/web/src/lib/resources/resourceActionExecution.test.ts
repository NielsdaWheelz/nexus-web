import { describe, expect, it, vi } from "vitest";
import {
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ShareOpenOptions } from "@/lib/sharing/types";

const ref = assumeCanonicalResourceRef(
  "media:11111111-1111-4111-8111-111111111111",
);
const subject: ResourceActionSubject = {
  kind: "Resource",
  ref,
  activation: {
    resourceRef: ref,
    kind: "route",
    href: "/media/11111111-1111-4111-8111-111111111111",
    unresolvedReason: null,
  },
  missing: false,
};

describe("resource action execution", () => {
  it("opens a Resource through its actual activation and supplied navigation", () => {
    const navigate = vi.fn();
    const resourceNavigation = {
      navigate,
    };

    executeResourceOpen({
      target: subject,
      resourceNavigation,
    });

    expect(navigate).toHaveBeenCalledWith(subject.activation.href);
  });

  it("opens Share with the canonical resource target and supplied options", () => {
    const openShare = vi.fn();
    const returnFocus = () => null;
    const options: ShareOpenOptions = {
      returnFocusTo: returnFocus,
      returnFocusFallback: {
        kind: "Present",
        value: returnFocus,
      },
    };

    executeResourceShare({ subject, openShare, options });

    expect(openShare).toHaveBeenCalledWith(
      { kind: "Resource", ref },
      options,
    );
  });

  it("lets supplied navigation and Share errors propagate", () => {
    const navigationError = new Error("navigation failed");

    expect(() =>
      executeResourceOpen({
        target: subject,
        resourceNavigation: {
          navigate: () => {
            throw navigationError;
          },
        },
      }),
    ).toThrow(navigationError);

    const shareError = new Error("share failed");
    expect(() =>
      executeResourceShare({
        subject,
        openShare: () => {
          throw shareError;
        },
        options: {
          returnFocusTo: () => null,
          returnFocusFallback: { kind: "Absent" },
        },
      }),
    ).toThrow(shareError);
  });
});
