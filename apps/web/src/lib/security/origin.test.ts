import { describe, expect, it } from "vitest";
import { isLocalhostOrigin, parseWebOrigin, parseWebOriginList } from "./origin";

describe("parseWebOrigin", () => {
  it("normalizes origin-only http and https URLs", () => {
    expect(parseWebOrigin(" https://App.Example.com/ ")).toEqual({
      origin: "https://app.example.com",
      protocol: "https:",
      hostname: "app.example.com",
      host: "app.example.com",
      isLocalhost: false,
    });
    expect(parseWebOrigin("http://localhost:3000")).toMatchObject({
      origin: "http://localhost:3000",
      protocol: "http:",
      hostname: "localhost",
      host: "localhost:3000",
      isLocalhost: true,
    });
  });

  it("rejects non-origin URLs", () => {
    expect(parseWebOrigin("https://app.example.com/path")).toBeNull();
    expect(parseWebOrigin("https://app.example.com?x=1")).toBeNull();
    expect(parseWebOrigin("https://user@app.example.com")).toBeNull();
    expect(parseWebOrigin("ftp://app.example.com")).toBeNull();
    expect(parseWebOrigin("not a url")).toBeNull();
  });
});

describe("parseWebOriginList", () => {
  it("dedupes valid origins and reports invalid entries", () => {
    expect(
      parseWebOriginList(
        "https://app.example.com, https://APP.example.com/, https://bad.example.com/path"
      )
    ).toEqual({
      origins: [
        {
          origin: "https://app.example.com",
          protocol: "https:",
          hostname: "app.example.com",
          host: "app.example.com",
          isLocalhost: false,
        },
      ],
      invalidValues: ["https://bad.example.com/path"],
    });
  });
});

describe("isLocalhostOrigin", () => {
  it("detects localhost origins", () => {
    expect(isLocalhostOrigin("http://localhost:3000")).toBe(true);
    expect(isLocalhostOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalhostOrigin("http://[::1]:3000")).toBe(true);
    expect(isLocalhostOrigin("https://app.example.com")).toBe(false);
  });
});
