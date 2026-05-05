"use client";

import { formatContributorCreditSummary } from "@/lib/contributors/formatting";
import type { ContributorCredit } from "@/lib/contributors/types";

export interface Media {
  title: string;
  contributors: ContributorCredit[];
}

export function buildCompactMediaPaneTitle(
  media: Pick<Media, "title" | "contributors"> | null | undefined
): string {
  const title = media?.title?.trim();
  if (!title) {
    return "Media";
  }

  const authorSummary = formatContributorCreditSummary(media?.contributors, 1);
  if (!authorSummary) {
    return title;
  }

  const compactTitle = `${title} · ${authorSummary}`;
  return compactTitle.length <= 56 ? compactTitle : title;
}

export function formatResumeTime(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
