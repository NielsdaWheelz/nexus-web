"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import type {
  MaterializedNexusTarget,
  NexusDispatchOutcome,
} from "@/lib/nexus/dispatch";
import type {
  NexusAction,
  NexusEntry,
  NexusTarget,
  NexusTargetActivation,
} from "@/lib/nexus/model";
import MobileQuickNoteHandoff, {
  type MaterializedDailyTextHandoffTarget,
  type MobileQuickNoteHandoffHandle,
} from "./MobileQuickNoteHandoff";

export interface MobileNexusActivationAdapterHandle {
  activate(
    action: NexusAction,
    activation: NexusTargetActivation,
    returnFocus: HTMLElement | null,
    entry?: NexusEntry,
  ): void;
}

export interface MobileNexusActivationAdapterProps {
  materialize(target: NexusTarget): MaterializedNexusTarget;
  dispatch(
    target: MaterializedNexusTarget,
    activation: NexusTargetActivation,
    entry?: NexusEntry,
  ): Promise<NexusDispatchOutcome>;
  onError(error: unknown): void;
}

function availableTarget(action: NexusAction): NexusTarget {
  if (action.availability.kind === "Unavailable") {
    throw new Error(
      `Unavailable Nexus action reached mobile activation: ${action.id}`,
    );
  }
  return action.availability.target;
}

function isDailyTextHandoffTarget(
  target: MaterializedNexusTarget,
): target is MaterializedDailyTextHandoffTarget {
  return (
    target.kind === "OpenDailyPage" && target.entry.kind === "AppendNote"
  );
}

const MobileNexusActivationAdapter = forwardRef<
  MobileNexusActivationAdapterHandle,
  MobileNexusActivationAdapterProps
>(function MobileNexusActivationAdapter(
  { materialize, dispatch, onError },
  ref,
) {
  const handoffRef = useRef<MobileQuickNoteHandoffHandle>(null);
  const activationSequenceRef = useRef(0);
  const dispatchPrepared = useCallback(
    (
      target: MaterializedNexusTarget,
      activation: NexusTargetActivation,
      entry: NexusEntry | undefined,
    ) =>
      entry
        ? dispatch(target, activation, entry)
        : dispatch(target, activation),
    [dispatch],
  );

  const activate = useCallback(
    (
      action: NexusAction,
      activation: NexusTargetActivation,
      returnFocus: HTMLElement | null,
      entry?: NexusEntry,
    ) => {
      const target = availableTarget(action);
      switch (action.activation.kind) {
        case "Standard": {
          activationSequenceRef.current += 1;
          const materialized = materialize(target);
          void dispatchPrepared(materialized, activation, entry).catch(onError);
          return;
        }
        case "DailyTextHandoff": {
          const handoff = handoffRef.current;
          if (!handoff) {
            throw new Error("Mobile daily text handoff is not mounted");
          }

          // The focus call must remain the first side effect in this branch.
          handoff.focus();
          activationSequenceRef.current += 1;
          const activationSequence = activationSequenceRef.current;
          let materialized: MaterializedNexusTarget;
          let dailyTarget: MaterializedDailyTextHandoffTarget;
          try {
            materialized = materialize(target);
            if (!isDailyTextHandoffTarget(materialized)) {
              throw new Error(
                "DailyTextHandoff activation materialized a non-daily target",
              );
            }
            dailyTarget = materialized;
            handoff.prepare(dailyTarget);
          } catch (error) {
            handoff.cancel(returnFocus);
            throw error;
          }
          let dispatched: Promise<NexusDispatchOutcome>;
          try {
            dispatched = dispatchPrepared(materialized, activation, entry);
          } catch (error) {
            handoff.cancel(returnFocus);
            throw error;
          }
          void dispatched.then(
            (outcome) => {
              if (activationSequenceRef.current !== activationSequence) {
                return;
              }
              if (outcome.kind === "DailyPageAccepted") {
                handoff.accept(dailyTarget, outcome);
                return;
              }
              handoff.cancel(returnFocus);
            },
            (error: unknown) => {
              if (activationSequenceRef.current === activationSequence) {
                handoff.cancel(returnFocus);
              }
              onError(error);
            },
          );
          return;
        }
        default: {
          const exhaustive: never = action.activation;
          throw new Error(
            `Unhandled mobile Nexus activation: ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    },
    [dispatchPrepared, materialize, onError],
  );

  useImperativeHandle(ref, () => ({ activate }), [activate]);

  return <MobileQuickNoteHandoff ref={handoffRef} />;
});

export default MobileNexusActivationAdapter;
