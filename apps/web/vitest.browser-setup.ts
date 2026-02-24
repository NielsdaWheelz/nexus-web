import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

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
