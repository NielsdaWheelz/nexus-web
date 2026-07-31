"use client";

import { useCallback } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  formatLocalDateInTimeZone,
  isLocalDate,
} from "@/lib/localDate";
import { useWorkspaceStore } from "@/lib/workspace/store";
import type {
  WorkspaceTargetActivationResult,
  WorkspaceTargetDisposition,
} from "@/lib/workspace/targetActivation";
import type { PaneNavigationModality } from "@/lib/workspace/paneReturnMemento";

export type OpenDailyPageTarget = {
  kind: "OpenDailyPage";
  localDate: "Today" | string;
  entry:
    | { kind: "View" }
    | {
        kind: "AppendNote";
        noteId: string;
        clientMutationId: string;
      };
};

export function createDailyAppendNoteEntry(): Extract<
  OpenDailyPageTarget["entry"],
  { kind: "AppendNote" }
> {
  return {
    kind: "AppendNote",
    noteId: crypto.randomUUID(),
    clientMutationId: crypto.randomUUID(),
  };
}

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
  value: OpenDailyPageTarget["localDate"],
  calendarTimeZone: string,
  now = new Date(),
): string {
  const localDate =
    value === "Today"
      ? formatLocalDateInTimeZone(now, calendarTimeZone)
      : value;
  if (!isLocalDate(localDate)) {
    throw new TypeError(
      "OpenDailyPage.localDate must be Today or a valid YYYY-MM-DD date",
    );
  }
  return localDate;
}

export function useResolveDailyLocalDate(): (
  value: OpenDailyPageTarget["localDate"],
) => string {
  const { calendarTimeZone } = useAuthenticatedAccount();
  return useCallback(
    (value) => resolveDailyLocalDate(value, calendarTimeZone),
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
      const localDate = resolveLocalDate(target.localDate);
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
