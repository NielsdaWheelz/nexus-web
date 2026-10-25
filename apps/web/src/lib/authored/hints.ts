/** The existing writing stream is only a wake hint. Feed cursors remain truth;
 * losing a hint cannot skip a command or advance the applied watermark. */
import { WIRE_REVISION } from "@/lib/api/wire.gen";
export function writingHints(accountId: string, wake: () => void): { start(): void; close(): void } {
  let active: AbortController | null = null;
  let retired = false;
  return {
    start() {
      if (retired || active) return;
      const controller = new AbortController(); active = controller;
      void (async () => {
        let failures = 0;
        while (!controller.signal.aborted) {
          try {
            const response = await fetch("/api/stream/writing", { credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { "X-Nexus-Wire": String(WIRE_REVISION), "X-Nexus-Account": accountId } });
            if ([401, 403, 426].includes(response.status)) { wake(); return; }
            if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("writing wake stream unavailable");
            const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = "";
            try {
              for (;;) {
                const { value, done } = await reader.read(); if (done) break;
                buffered += decoder.decode(value, { stream: true });
                if (buffered.length > 256 * 1024) throw new Error("writing wake event exceeds bound");
                let delimiter: RegExpExecArray | null;
                while ((delimiter = /\r?\n\r?\n/u.exec(buffered)) !== null) { buffered = buffered.slice(delimiter.index + delimiter[0].length); failures = 0; wake(); }
              }
            } finally { await reader.cancel(); reader.releaseLock(); }
          } catch { if (controller.signal.aborted) return; failures++; wake(); }
          const delay = failures ? Math.min(30_000, 1000 * 2 ** Math.min(5, failures)) * (0.75 + Math.random() / 4) : 250;
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
      })().finally(() => { if (active === controller) active = null; });
    },
    close() { retired = true; active?.abort(); active = null; },
  };
}
