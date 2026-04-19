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
    unoptimized: _unoptimized,
    ...props
  }: {
    src: string | { src: string };
    alt: string;
    unoptimized?: boolean;
    [key: string]: unknown;
  }) =>
    createElement("img", {
      ...props,
      alt,
      src: typeof src === "string" ? src : src.src,
    }),
}));

if (typeof globalThis.process === "undefined") {
  (globalThis as Record<string, unknown>).process = {
    env: { NODE_ENV: "test" },
    cwd: () => "/",
    platform: "browser",
  };
}

afterEach(() => {
  cleanup();
});
