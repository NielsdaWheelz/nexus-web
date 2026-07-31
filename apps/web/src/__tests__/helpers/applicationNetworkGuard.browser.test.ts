import { expect, test } from "vitest";

test("browser proof rejects external application network calls", () => {
  expect(() => fetch("https://example.com/api")).toThrow(
    "Blocked external fetch origin: https://example.com",
  );
  expect(() => new EventSource("https://example.com/events")).toThrow(
    "Blocked external EventSource origin: https://example.com",
  );
  expect(() => new WebSocket("wss://example.com/socket")).toThrow(
    "Blocked external WebSocket origin: wss://example.com",
  );
});
