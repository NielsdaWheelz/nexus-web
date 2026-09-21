"""Podcast sync vocabulary and scheduling constants."""

from __future__ import annotations

from typing import Literal

type PodcastSyncStatus = Literal["Pending", "Running", "Complete", "SourceLimited", "Failed"]

PODCAST_SYNC_INTERACTIVE_PRIORITY = 75
PODCAST_SYNC_BULK_PRIORITY = 100
PODCAST_SYNC_JOB_LEASE_SECONDS = 900
PODCAST_HEALTHY_SYNC_BASE_SECONDS = 23 * 60 * 60
PODCAST_HEALTHY_SYNC_JITTER_MAX_SECONDS = 30 * 60
PODCAST_SYNC_FAILURE_BACKOFF_SECONDS = (15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60)
PODCAST_REFRESH_DUE_MAX_LIMIT = 100
PODCAST_SYNC_ERROR_MESSAGE_MAX_LENGTH = 1_000
