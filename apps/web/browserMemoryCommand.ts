import { readFile } from "node:fs/promises";
import type { BrowserCommandContext } from "vitest/node";

function bytes(contents: string, field: string): number {
  const match = contents.match(new RegExp("^" + field + ":\\s+([0-9]+) kB$", "m"));
  if (match === null) throw new Error("Owned browser process omitted " + field);
  const value = Number(match[1]) * 1024;
  if (!Number.isSafeInteger(value)) throw new Error("Browser memory exceeds exact byte accounting");
  return value;
}

/** Read only processes reported by this test's actual browser connection. */
export async function readBrowserProcessMemory({ context }: BrowserCommandContext) {
  if (process.platform !== "linux") return { kind: "TraceRequired" } as const;
  const browser = context.browser();
  if (browser === null) throw new Error("Memory observation requires the owned browser");
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    if (processInfo.length === 0) throw new Error("Owned browser omitted its process identities");
    const processes = [];
    for (const { id: pid, type } of processInfo) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Browser returned an invalid process identity");
      const [rollup, status] = await Promise.all([
        readFile("/proc/" + pid + "/smaps_rollup", "utf8"),
        readFile("/proc/" + pid + "/status", "utf8"),
      ]);
      // A process exiting during either read invalidates this observation.
      // Never replace a missing process with zero or a trace measurement.
      const rssBytes = bytes(rollup, "Rss");
      if (rssBytes === 0) throw new Error("Owned browser process has no resident memory");
      processes.push({ pid, type, rssBytes,
        privateResidentBytes: bytes(rollup, "Private_Clean") + bytes(rollup, "Private_Dirty"),
        swapBytes: bytes(rollup, "Swap"), highWaterBytes: bytes(status, "VmHWM") });
    }
    return { kind: "LinuxProcessMemory", processes,
      privateResidentBytes: processes.reduce((sum, item) => sum + item.privateResidentBytes, 0),
      rssBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
      swapBytes: processes.reduce((sum, item) => sum + item.swapBytes, 0),
      sumHighWaterBytes: processes.reduce((sum, item) => sum + item.highWaterBytes, 0) } as const;
  } finally { await session.detach(); }
}

declare module "vitest/browser" {
  interface BrowserCommands {
    readBrowserProcessMemory(): ReturnType<typeof readBrowserProcessMemory>;
  }
}
