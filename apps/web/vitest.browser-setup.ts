import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { afterEach } from "vitest";
import { vi } from "vitest";
import { cleanup } from "@testing-library/react";

vi.mock("next/image", () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    priority: _priority,
    unoptimized: _unoptimized,
    ...props
  }: {
    src: string | { src: string };
    alt: string;
    priority?: boolean;
    unoptimized?: boolean;
    [key: string]: unknown;
  }) =>
    createElement("img", {
      ...props,
      alt,
      src: typeof src === "string" ? src : src.src,
    }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
