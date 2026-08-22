"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { isAbortError } from "@/lib/errors";
import { offlineReadingRejectionMessage } from "./presentation";
import {
  OfflineReadingControllerRuntime,
  OfflineReadingForeignBindingError,
  OfflineReadingRejectedError,
} from "./runtime";
import {
  createWebKitOfflineReadingTransport,
  type OfflineReadingTransport,
} from "./transport";

export type OfflineReadingCapability =
  | { readonly kind: "Unavailable" }
  | { readonly kind: "Connecting" }
  | {
      readonly kind: "Ready";
      readonly controller: OfflineReadingControllerRuntime;
    };

const UNAVAILABLE: OfflineReadingCapability = { kind: "Unavailable" };
const CONNECTING: OfflineReadingCapability = { kind: "Connecting" };
const OFFLINE_READING_CONNECT_FEEDBACK_KEY = "offline-reading-connect";
const OfflineReadingContext = createContext<OfflineReadingCapability>(UNAVAILABLE);

export function OfflineReadingProvider({
  accountId,
  children,
  transport,
}: {
  readonly accountId: string;
  readonly children: ReactNode;
  readonly transport?: OfflineReadingTransport | null;
}) {
  const feedback = useFeedback();
  // The capability is keyed on the hosted account: an in-place account switch
  // must never keep projecting the previous account's binding or inventory
  // (TB-15). Until the new session connects the capability reads Connecting.
  const [session, setSession] = useState<{
    readonly accountId: string;
    readonly capability: OfflineReadingCapability;
  }>({ accountId, capability: UNAVAILABLE });
  const capability =
    session.accountId === accountId ? session.capability : CONNECTING;
  const [defect, setDefect] = useState<Error | null>(null);

  useEffect(() => {
    const sessionTransport =
      transport === undefined ? createWebKitOfflineReadingTransport() : transport;
    if (sessionTransport === null) {
      setSession({ accountId, capability: UNAVAILABLE });
      return;
    }
    const controller = new OfflineReadingControllerRuntime(sessionTransport, {
      expectedAccountId: accountId,
    });
    let current = true;

    const degrade = (message: string) => {
      setSession({ accountId, capability: UNAVAILABLE });
      feedback.publish({
        kind: "Hud",
        key: OFFLINE_READING_CONNECT_FEEDBACK_KEY,
        content: {
          tone: "Warning",
          title: "Offline reading is unavailable",
          message,
        },
      });
    };

    const unsubscribeDefect = controller.subscribeDefect((error) => {
      if (!current) return;
      degrade(
        error instanceof OfflineReadingForeignBindingError
          ? "Your account changed. Reopen Nexus to use offline reading."
          : offlineReadingRejectionMessage("Failed"),
      );
    });

    setSession({ accountId, capability: CONNECTING });
    void controller.connect("Hosted").then(
      () => {
        if (!current) return;
        feedback.resolve(OFFLINE_READING_CONNECT_FEEDBACK_KEY);
        setSession({ accountId, capability: { kind: "Ready", controller } });
      },
      (error: unknown) => {
        if (!current || isAbortError(error)) return;
        // A rejected or refused connect is a supported degraded state: the APK
        // keeps every installed copy readable and reports hosted
        // authorization/sync unavailable. Only a genuine same-system defect
        // escapes to the workspace error boundary.
        if (error instanceof OfflineReadingRejectedError) {
          degrade(offlineReadingRejectionMessage(error.code));
          return;
        }
        if (error instanceof OfflineReadingForeignBindingError) {
          degrade("Your account changed. Reopen Nexus to use offline reading.");
          return;
        }
        setSession({ accountId, capability: UNAVAILABLE });
        setDefect(
          error instanceof Error
            ? error
            : new Error("Offline reading connection failed"),
        );
      },
    );
    return () => {
      current = false;
      unsubscribeDefect();
      controller.dispose();
    };
  }, [accountId, feedback, transport]);

  if (defect !== null) throw defect;
  return (
    <OfflineReadingContext.Provider value={capability}>
      {children}
    </OfflineReadingContext.Provider>
  );
}

export function useOfflineReadingCapability(): OfflineReadingCapability {
  return useContext(OfflineReadingContext);
}
