import { cdp, commands } from "vitest/browser";
import { expectRecord, isRecord } from "@/lib/validation";

/** Actual owned Chromium processes, including workers and native allocations. */
export async function nativeBrowserMemory() {
  const observed = await commands.readBrowserProcessMemory();
  if (observed.kind === "LinuxProcessMemory") return observed;
  // Preserve existing non-Linux diagnostics; Linux qualification uses only proc.
  const session = cdp();
  // Initialize Vitest's lazy CDP connection before registering its listeners.
  await session.send("Runtime.getHeapUsage");
  const totals = new Map<number, Record<string, unknown>>();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const collect: Parameters<typeof session.on<"Tracing.dataCollected">>[1] = ({ value }) => {
    // CDP types declare trace fields as strings; memory-infra emits objects.
    for (const raw of value) {
      const event: unknown = raw;
      if (!isRecord(event) || event.ph !== "v") continue;
      const args = expectRecord(event.args, "memory trace arguments");
      const dumps = expectRecord(args.dumps, "memory trace dump");
      if (dumps.process_totals === undefined) continue;
      if (typeof event.pid !== "number" || !Number.isSafeInteger(event.pid) || event.pid <= 0) throw new Error("Memory trace omitted its process identity");
      totals.set(event.pid, expectRecord(dumps.process_totals, "memory trace process totals"));
    }
  };
  session.on("Tracing.dataCollected", collect);
  session.on("Tracing.tracingComplete", finish);
  try {
    await session.send("Tracing.start", { categories: "disabled-by-default-memory-infra", transferMode: "ReportEvents" });
    try {
      const dump = await session.send("Tracing.requestMemoryDump", { deterministic: true, levelOfDetail: "detailed" });
      if (!dump.success) throw new Error("Owned Chromium did not provide its native memory dump");
    } finally { await session.send("Tracing.end"); await completed; }
    if (totals.size === 0) throw new Error("Completed owned trace has no process memory observations");
    const processes = [];
    for (const [pid, values] of totals) {
      const footprint = values.private_footprint_bytes;
      const peak = values.peak_resident_set_size;
      if (typeof footprint !== "string" || !/^[0-9a-f]+$/i.test(footprint) || typeof peak !== "string" || !/^[0-9a-f]+$/i.test(peak)) {
        throw new Error(`Owned browser process ${pid} lacks private-footprint/high-water values`);
      }
      processes.push({ pid, privateFootprintBytes: Number.parseInt(footprint, 16), highWaterBytes: Number.parseInt(peak, 16), highWaterResettable: values.is_peak_rss_resettable });
    }
    return { kind: "ChromiumTrace" as const, processes, privateFootprintBytes: processes.reduce((sum, process) => sum + process.privateFootprintBytes, 0),
      sumHighWaterBytes: processes.reduce((sum, process) => sum + process.highWaterBytes, 0) };
  } finally {
    session.off("Tracing.dataCollected", collect);
    session.off("Tracing.tracingComplete", finish);
  }
}
