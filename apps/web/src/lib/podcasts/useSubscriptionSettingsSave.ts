"use client";

// A subscription settings command freezes its target and body. Refused retries
// resend it exactly; uncertain outcomes are read back before another decision.
// The caller supplies an account/load subject and compares the captured
// subscription identity with refreshed reads. A replacement requires reopening.
// Subject changes and unmount retire presentation only: a sent write may still commit.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type ApiError, outcomeUnknown } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { modeledApiError, requestWithRetry, useThrowLater } from "@/lib/api/serverState";
import type { Schema } from "@/lib/api/wire";
import { useWorkGuard } from "@/lib/unsavedWork";
import { getSubscription, savePodcastSubscriptionSettings, type PodcastSubscription } from "./api";

type Patch = Schema<"PodcastSubscriptionSettingsPatchRequest">;
type Command = { readonly patch: Patch };
type Reason = "Conflict" | "Unknown";
type SubscriptionSettingsSave =
  | { readonly kind: "Saving"; readonly command: Command }
  | { readonly kind: "Accepted"; readonly command: Command; readonly current: PodcastSubscription }
  | { readonly kind: "Rejected"; readonly command: Command; readonly error: ApiError }
  | { readonly kind: "Unknown"; readonly command: Command; readonly error: ApiError }
  | { readonly kind: "Reading"; readonly command: Command; readonly reason: Reason }
  | { readonly kind: "Review"; readonly command: Command; readonly reason: Reason; readonly current: PodcastSubscription }
  | { readonly kind: "ReadFailed"; readonly command: Command; readonly reason: Reason; readonly error: ApiError }
  | { readonly kind: "Absent"; readonly command: Command }
  | { readonly kind: "Replaced"; readonly command: Command };

export function useSubscriptionSettingsSave(podcastId: string | null, subject: string | null) {
  const fail = useThrowLater();
  const [receipt, setReceipt] = useState<{ readonly subject: string | null; readonly state: SubscriptionSettingsSave } | null>(null);
  const state = receipt !== null && receipt.subject === subject ? receipt.state : null;
  const guard = useWorkGuard();
  const ownerId = `podcast-settings-save:${useId()}`;
  const unconfirmed = state?.kind === "Saving" || state?.kind === "Unknown" ||
    ((state?.kind === "Reading" || state?.kind === "ReadFailed") && state.reason === "Unknown");
  useLayoutEffect(() => guard.register({
    id: ownerId,
    scope: { kind: "surface", id: ownerId },
    read: () => ({ changed: false, unconfirmed, stopsBrowserWork: false }),
    subscribe: () => () => {},
  }), [guard, ownerId, unconfirmed]);
  const currentSubject = useRef(subject);
  currentSubject.current = subject;
  const flight = useRef<{ readonly subject: string | null; readonly token: object } | null>(null);
  const setState = (value: SubscriptionSettingsSave | null) => {
    if (currentSubject.current === subject) setReceipt(value === null ? null : { subject, state: value });
  };
  const isCurrent = (token: object) => flight.current?.token === token && currentSubject.current === subject;
  useEffect(() => () => { flight.current = null; }, []);

  const read = async (command: Command, reason: Reason, token: object): Promise<PodcastSubscription | null> => {
    if (podcastId === null) return null;
    setState({ kind: "Reading", command, reason });
    try {
      const current = await requestWithRetry(signal => getSubscription(podcastId, signal), new AbortController().signal);
      if (!isCurrent(token)) return null;
      if (current.subscription_id !== command.patch.expected_subscription_id) {
        setState({ kind: "Replaced", command });
        return null;
      }
      const patch = command.patch;
      const matches =
        current.default_playback_speed === patch.default_playback_speed &&
        current.pause_shortening_mode === patch.pause_shortening_mode;
      if (reason === "Unknown" && matches) {
        publishChange("Podcasts");
        setState({ kind: "Accepted", command, current });
        return current;
      }
      setState({ kind: "Review", command, reason, current });
    } catch (caught) {
      if (!isCurrent(token)) return null;
      const error = modeledApiError(caught, fail);
      if (error?.code === "E_NOT_FOUND") setState({ kind: "Absent", command });
      else if (error) setState({ kind: "ReadFailed", command, reason, error });
      else setState(null);
    }
    return null;
  };

  const send = async (command: Command): Promise<PodcastSubscription | null> => {
    if (podcastId === null || subject === null || currentSubject.current !== subject || flight.current?.subject === subject) return null;
    const token = {};
    flight.current = { subject, token };
    setState({ kind: "Saving", command });
    try {
      const current = await savePodcastSubscriptionSettings(podcastId, command.patch);
      if (!isCurrent(token)) return null;
      setState({ kind: "Accepted", command, current });
      return current;
    } catch (caught) {
      if (!isCurrent(token)) return null;
      const error = modeledApiError(caught, fail);
      if (error?.code === "E_RESOURCE_CONFLICT") await read(command, "Conflict", token);
      else if (error?.code === "E_NOT_FOUND") setState({ kind: "Absent", command });
      else if (error) setState({ kind: outcomeUnknown(error) ? "Unknown" : "Rejected", command, error });
      else setState(null);
      return null;
    } finally {
      if (flight.current?.token === token) flight.current = null;
    }
  };

  return {
    ownerId,
    state,
    reset: (subscriptionId: string | null) => {
      if (flight.current?.subject === subject) return;
      if ((state?.kind === "Rejected" || state?.kind === "Unknown" || state?.kind === "ReadFailed") &&
        (subscriptionId === null || subscriptionId === state.command.patch.expected_subscription_id)) return;
      setState(null);
    },
    busy: state?.kind === "Saving" || state?.kind === "Reading",
    save: (patch: Patch) => send({ patch: { ...patch } }),
    retry: () => state?.kind === "Rejected" ? send(state.command) : Promise.resolve(null),
    check: async () => {
      if (currentSubject.current !== subject || flight.current?.subject === subject || (state?.kind !== "Unknown" && state?.kind !== "ReadFailed")) return null;
      const token = {};
      flight.current = { subject, token };
      try {
        return await read(state.command, state.kind === "Unknown" ? "Unknown" : state.reason, token);
      } finally {
        if (flight.current?.token === token) flight.current = null;
      }
    },
  };
}
