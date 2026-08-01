"use client";

import { useCallback } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  formatLocalDateInTimeZone,
  isLocalDate,
} from "@/lib/localDate";
import { useWorkspaceStore } from "@/lib/workspace/store";
import type {
  DailyPageLocator,
  MaterializedOpenDailyPageTarget,
} from "@/lib/nexus/model";
import type {
  WorkspaceTargetActivationResult,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";

export type OpenDailyPageTarget =
  | MaterializedOpenDailyPageTarget
  | {
      readonly kind: "OpenDailyPage";
      readonly date: DailyPageLocator;
      readonly entry: { readonly kind: "View" };
    };

export interface OpenDailyPageActivation {
  disposition: WorkspaceTargetDisposition;
  modality: PaneNavigationModality;
}

export interface OpenDailyPageResult {
  localDate: string;
  activationId: string;
  activation: WorkspaceTargetActivationResult;
}

export function resolveDailyLocalDate(
  locator: DailyPageLocator,
  calendarTimeZone: string,
  now = new Date(),
): string {
  const localDate =
    locator.kind === "Today"
      ? formatLocalDateInTimeZone(now, calendarTimeZone)
      : locator.value;
  if (!isLocalDate(localDate)) {
    throw new TypeError(
      "OpenDailyPage date must be a valid YYYY-MM-DD local date",
    );
  }
  return localDate;
}

export function useResolveDailyLocalDate(): (
  locator: DailyPageLocator,
) => string {
  const { calendarTimeZone } = useAuthenticatedAccount();
  return useCallback(
    (locator) => resolveDailyLocalDate(locator, calendarTimeZone),
    [calendarTimeZone],
  );
}

export function useOpenDailyPage(): (
  target: OpenDailyPageTarget,
  activation?: OpenDailyPageActivation,
) => OpenDailyPageResult {
  const resolveLocalDate = useResolveDailyLocalDate();
  const { state, activateWorkspaceTarget } = useWorkspaceStore();
  return useCallback(
    (
      target: OpenDailyPageTarget,
      activation: OpenDailyPageActivation = {
        disposition: { kind: "Adopt" },
        modality: "Programmatic",
      },
    ): OpenDailyPageResult => {
      const localDate = resolveLocalDate(target.date);
      const activationId = crypto.randomUUID();
      const result = activateWorkspaceTarget({
        originPaneId: state.activePrimaryPaneId,
        target: {
          href: `/daily/${localDate}`,
          aliases: [`daily:${localDate}`],
        },
        disposition: activation.disposition,
        modality: activation.modality,
        paneEntryActivation: {
          activationId,
          entry:
            target.entry.kind === "AppendNote"
              ? {
                  kind: "AppendNote",
                  noteId: target.entry.noteId,
                  clientMutationId: target.entry.clientMutationId,
                  initialText: target.entry.initialText,
                }
              : null,
        },
      });
      return { localDate, activationId, activation: result };
    },
    [
      activateWorkspaceTarget,
      resolveLocalDate,
      state.activePrimaryPaneId,
    ],
  );
}
