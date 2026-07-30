import type { OfflineMediaCommand } from "./contract";

export interface OfflineMediaTransport {
  readonly start: (onMessage: (message: unknown) => void) => () => void;
  readonly send: (command: OfflineMediaCommand) => void;
}

interface WebKitMessageEvent {
  readonly data: unknown;
}

interface WebKitOfflineMediaPort {
  postMessage(message: string): void;
  onmessage: ((event: WebKitMessageEvent) => void) | null;
}

type OfflineMediaWindow = Window & {
  nexusOfflineMedia?: WebKitOfflineMediaPort;
};

export function createWebKitOfflineMediaTransport(
  target:
    | Pick<OfflineMediaWindow, "nexusOfflineMedia">
    | undefined = typeof window === "undefined"
    ? undefined
    : (window as OfflineMediaWindow),
): OfflineMediaTransport | null {
  const port = target?.nexusOfflineMedia;
  if (port === undefined) return null;

  return {
    start(onMessage) {
      const receive = (event: WebKitMessageEvent) => {
        if (typeof event.data !== "string") {
          onMessage(event.data);
          return;
        }
        try {
          onMessage(JSON.parse(event.data) as unknown);
        } catch {
          onMessage(event.data);
        }
      };
      port.onmessage = receive;
      return () => {
        if (port.onmessage === receive) port.onmessage = null;
      };
    },
    send(command) {
      port.postMessage(JSON.stringify(command));
    },
  };
}
