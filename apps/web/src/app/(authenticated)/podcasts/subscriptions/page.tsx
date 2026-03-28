"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import { useSetPaneTitle } from "@/lib/panes/paneRuntime";
import {
  SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS,
  formatPlaybackSpeedLabel,
} from "@/lib/player/subscriptionPlaybackSpeed";
import PageLayout from "@/components/ui/PageLayout";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import SortableList from "@/components/sortable/SortableList";
import styles from "./page.module.css";

const SUBSCRIPTIONS_PAGE_SIZE = 100;
type SubscriptionSort = "recent_episode" | "unplayed_count" | "alpha";
type CategoryFilter = "all" | "uncategorized" | string;

interface PodcastSubscriptionCategoryRef {
  id: string;
  name: string;
  color: string | null;
}

interface PodcastSubscriptionCategory {
  id: string;
  name: string;
  position: number;
  color: string | null;
  created_at: string;
  subscription_count: number;
  unplayed_count: number;
}

interface PodcastListItem {
  id: string;
  provider: string;
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface PodcastSubscriptionRow {
  podcast_id: string;
  status: "active" | "unsubscribed";
  unsubscribe_mode: 1 | 2 | 3;
  default_playback_speed?: number | null;
  auto_queue?: boolean;
  category?: PodcastSubscriptionCategoryRef | null;
  sync_status: "pending" | "running" | "partial" | "complete" | "source_limited" | "failed";
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  last_synced_at: string | null;
  updated_at: string;
  unplayed_count: number;
  podcast: PodcastListItem;
}

interface PodcastSubscriptionSettingsResponse {
  podcast_id: string;
  default_playback_speed: number | null;
  auto_queue: boolean;
  category: PodcastSubscriptionCategoryRef | null;
  updated_at: string;
}

interface PodcastSubscriptionSyncRefreshResult {
  podcast_id: string;
  sync_status: PodcastSubscriptionRow["sync_status"];
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  sync_enqueued: boolean;
}

interface PodcastPlanSnapshot {
  plan: {
    plan_tier: "free" | "paid";
    daily_transcription_minutes: number | null;
    initial_episode_window: number;
  };
  usage: {
    usage_date: string;
    used_minutes: number;
    reserved_minutes: number;
    total_minutes: number;
    remaining_minutes: number | null;
  };
}

interface PodcastOpmlImportResult {
  total: number;
  imported: number;
  skipped_already_subscribed: number;
  skipped_invalid: number;
  errors: Array<{
    feed_url: string | null;
    error: string;
  }>;
}

export default function PodcastSubscriptionsPage() {
  const [rows, setRows] = useState<PodcastSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busyPodcastIds, setBusyPodcastIds] = useState<Set<string>>(new Set());
  const [refreshingPodcastIds, setRefreshingPodcastIds] = useState<Set<string>>(new Set());
  const [subscriptionSort, setSubscriptionSort] = useState<SubscriptionSort>("recent_episode");
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<CategoryFilter>("all");
  const [categories, setCategories] = useState<PodcastSubscriptionCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [categoryMutationBusy, setCategoryMutationBusy] = useState(false);
  const [categoryMutationError, setCategoryMutationError] = useState<string | null>(null);
  const [categoryFormOpen, setCategoryFormOpen] = useState(false);
  const [categoryFormMode, setCategoryFormMode] = useState<"create" | "edit">("create");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryNameInput, setCategoryNameInput] = useState("");
  const [categoryColorInput, setCategoryColorInput] = useState("");
  const [unsubscribeMode, setUnsubscribeMode] = useState<1 | 2 | 3>(1);
  const [plan, setPlan] = useState<PodcastPlanSnapshot | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<PodcastOpmlImportResult | null>(null);
  const [settingsPodcastId, setSettingsPodcastId] = useState<string | null>(null);
  const [settingsDefaultSpeed, setSettingsDefaultSpeed] = useState<string>("default");
  const [settingsAutoQueue, setSettingsAutoQueue] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsCategoryId, setSettingsCategoryId] = useState<string>("");
  useSetPaneTitle("My podcasts");

  const loadSubscriptions = useCallback(async (offset = 0, append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(SUBSCRIPTIONS_PAGE_SIZE),
        offset: String(offset),
        sort: subscriptionSort,
      });
      if (activeCategoryFilter === "uncategorized") {
        params.set("category_id", "null");
      } else if (activeCategoryFilter !== "all") {
        params.set("category_id", activeCategoryFilter);
      }
      const response = await apiFetch<{ data: PodcastSubscriptionRow[] }>(
        `/api/podcasts/subscriptions?${params.toString()}`
      );
      setRows((prev) => (append ? [...prev, ...response.data] : response.data));
      setHasMore(response.data.length === SUBSCRIPTIONS_PAGE_SIZE);
      setNextOffset(offset + response.data.length);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setError(loadError.message);
      } else {
        setError("Failed to load subscriptions");
      }
    } finally {
      if (append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, [activeCategoryFilter, subscriptionSort]);

  const loadPlanSnapshot = useCallback(async () => {
    setPlanLoading(true);
    setPlanError(null);
    try {
      const response = await apiFetch<{ data: PodcastPlanSnapshot }>("/api/podcasts/plan");
      setPlan(response.data);
    } catch (loadError) {
      if (isApiError(loadError)) {
        setPlanError(loadError.message);
      } else {
        setPlanError("Failed to load plan and quota snapshot");
      }
    } finally {
      setPlanLoading(false);
    }
  }, []);

  const loadCategories = useCallback(async () => {
    setCategoriesLoading(true);
    setCategoriesError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionCategory[] }>("/api/podcasts/categories");
      setCategories(response.data);
      if (
        activeCategoryFilter !== "all" &&
        activeCategoryFilter !== "uncategorized" &&
        !response.data.some((category) => category.id === activeCategoryFilter)
      ) {
        setActiveCategoryFilter("all");
      }
    } catch (loadError) {
      if (isApiError(loadError)) {
        setCategoriesError(loadError.message);
      } else {
        setCategoriesError("Failed to load categories");
      }
    } finally {
      setCategoriesLoading(false);
    }
  }, [activeCategoryFilter]);

  useEffect(() => {
    void loadSubscriptions();
    void loadPlanSnapshot();
    void loadCategories();
  }, [loadCategories, loadPlanSnapshot, loadSubscriptions]);

  const handleUnsubscribe = useCallback(async (podcastId: string) => {
    setBusyPodcastIds((prev) => new Set(prev).add(podcastId));
    setError(null);
    try {
      await apiFetch(`/api/podcasts/subscriptions/${podcastId}?mode=${unsubscribeMode}`, {
        method: "DELETE",
      });
      setRows((prev) => prev.filter((row) => row.podcast_id !== podcastId));
    } catch (unsubscribeError) {
      if (isApiError(unsubscribeError)) {
        setError(unsubscribeError.message);
      } else {
        setError("Failed to unsubscribe from podcast");
      }
    } finally {
      setBusyPodcastIds((prev) => {
        const next = new Set(prev);
        next.delete(podcastId);
        return next;
      });
    }
  }, [unsubscribeMode]);

  const handleRefreshSync = useCallback(async (podcastId: string) => {
    setRefreshingPodcastIds((prev) => new Set(prev).add(podcastId));
    setError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionSyncRefreshResult }>(
        `/api/podcasts/subscriptions/${podcastId}/sync`,
        { method: "POST" }
      );
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === podcastId
            ? {
                ...row,
                sync_status: response.data.sync_status,
                sync_error_code: response.data.sync_error_code,
                sync_error_message: response.data.sync_error_message,
                sync_attempts: response.data.sync_attempts,
              }
            : row
        )
      );
    } catch (refreshError) {
      if (isApiError(refreshError)) {
        setError(refreshError.message);
      } else {
        setError("Failed to refresh podcast sync");
      }
    } finally {
      setRefreshingPodcastIds((prev) => {
        const next = new Set(prev);
        next.delete(podcastId);
        return next;
      });
    }
  }, []);

  const activeCount = useMemo(
    () => rows.filter((row) => row.status === "active").length,
    [rows]
  );
  const settingsRow = useMemo(
    () => rows.find((row) => row.podcast_id === settingsPodcastId) ?? null,
    [rows, settingsPodcastId]
  );
  const uncategorizedUnplayedCount = useMemo(
    () =>
      rows
        .filter((row) => !row.category)
        .reduce((total, row) => total + Math.max(0, Number(row.unplayed_count || 0)), 0),
    [rows]
  );

  const openSettingsModal = useCallback((row: PodcastSubscriptionRow) => {
    setSettingsPodcastId(row.podcast_id);
    setSettingsDefaultSpeed(
      row.default_playback_speed == null ? "default" : String(row.default_playback_speed)
    );
    setSettingsAutoQueue(Boolean(row.auto_queue));
    setSettingsCategoryId(row.category?.id ?? "");
    setSettingsError(null);
  }, []);

  const closeSettingsModal = useCallback(() => {
    setSettingsPodcastId(null);
    setSettingsError(null);
    setSettingsBusy(false);
  }, []);

  const handleSaveSettings = useCallback(async () => {
    if (!settingsRow) {
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    setError(null);
    const nextDefaultPlaybackSpeed =
      settingsDefaultSpeed === "default" ? null : Number.parseFloat(settingsDefaultSpeed);
    const nextCategoryId = settingsCategoryId.trim();
    try {
      const response = await apiFetch<{ data: PodcastSubscriptionSettingsResponse }>(
        `/api/podcasts/subscriptions/${settingsRow.podcast_id}/settings`,
        {
          method: "PATCH",
          body: JSON.stringify({
            default_playback_speed: nextDefaultPlaybackSpeed,
            auto_queue: settingsAutoQueue,
            category_id: nextCategoryId.length > 0 ? nextCategoryId : null,
          }),
        }
      );
      setRows((prev) =>
        prev.map((row) =>
          row.podcast_id === settingsRow.podcast_id
            ? {
                ...row,
                default_playback_speed: response.data.default_playback_speed,
                auto_queue: response.data.auto_queue,
                category: response.data.category,
                updated_at: response.data.updated_at ?? row.updated_at,
              }
            : row
        )
      );
      setSettingsPodcastId(null);
    } catch (settingsUpdateError) {
      if (isApiError(settingsUpdateError)) {
        setSettingsError(settingsUpdateError.message);
      } else {
        setSettingsError("Failed to save subscription settings");
      }
    } finally {
      setSettingsBusy(false);
    }
  }, [settingsAutoQueue, settingsCategoryId, settingsDefaultSpeed, settingsRow]);

  const handleAssignCategory = useCallback(
    async (podcastId: string, categoryId: string) => {
      setBusyPodcastIds((prev) => new Set(prev).add(podcastId));
      setCategoryMutationError(null);
      setError(null);
      try {
        const response = await apiFetch<{ data: PodcastSubscriptionSettingsResponse }>(
          `/api/podcasts/subscriptions/${podcastId}/settings`,
          {
            method: "PATCH",
            body: JSON.stringify({
              category_id: categoryId.trim() ? categoryId : null,
            }),
          }
        );
        setRows((prev) =>
          prev.map((row) =>
            row.podcast_id === podcastId
              ? {
                  ...row,
                  category: response.data.category,
                  updated_at: response.data.updated_at ?? row.updated_at,
                }
              : row
          )
        );
        if (activeCategoryFilter !== "all") {
          await loadSubscriptions(0, false);
        }
        await loadCategories();
      } catch (updateError) {
        if (isApiError(updateError)) {
          setCategoryMutationError(updateError.message);
        } else {
          setCategoryMutationError("Failed to assign category");
        }
      } finally {
        setBusyPodcastIds((prev) => {
          const next = new Set(prev);
          next.delete(podcastId);
          return next;
        });
      }
    },
    [activeCategoryFilter, loadCategories, loadSubscriptions]
  );

  const openCreateCategoryForm = useCallback(() => {
    setCategoryFormMode("create");
    setEditingCategoryId(null);
    setCategoryNameInput("");
    setCategoryColorInput("");
    setCategoryMutationError(null);
    setCategoryFormOpen(true);
  }, []);

  const openEditCategoryForm = useCallback((category: PodcastSubscriptionCategory) => {
    setCategoryFormMode("edit");
    setEditingCategoryId(category.id);
    setCategoryNameInput(category.name);
    setCategoryColorInput(category.color ?? "");
    setCategoryMutationError(null);
    setCategoryFormOpen(true);
  }, []);

  const closeCategoryForm = useCallback(() => {
    setCategoryFormOpen(false);
    setEditingCategoryId(null);
    setCategoryMutationError(null);
  }, []);

  const handleSaveCategoryForm = useCallback(async () => {
    const trimmedName = categoryNameInput.trim();
    if (!trimmedName) {
      setCategoryMutationError("Category name is required");
      return;
    }
    const trimmedColor = categoryColorInput.trim();
    const payload: { name: string; color?: string | null } = { name: trimmedName };
    if (trimmedColor.length > 0) {
      payload.color = trimmedColor;
    } else if (categoryFormMode === "edit") {
      payload.color = null;
    }

    setCategoryMutationBusy(true);
    setCategoryMutationError(null);
    try {
      if (categoryFormMode === "create") {
        await apiFetch<{ data: PodcastSubscriptionCategory }>("/api/podcasts/categories", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } else if (editingCategoryId) {
        await apiFetch<{ data: PodcastSubscriptionCategory }>(
          `/api/podcasts/categories/${editingCategoryId}`,
          {
            method: "PATCH",
            body: JSON.stringify(payload),
          }
        );
      }
      await loadCategories();
      closeCategoryForm();
    } catch (mutationError) {
      if (isApiError(mutationError)) {
        setCategoryMutationError(mutationError.message);
      } else {
        setCategoryMutationError("Failed to save category");
      }
    } finally {
      setCategoryMutationBusy(false);
    }
  }, [
    categoryColorInput,
    categoryFormMode,
    categoryNameInput,
    closeCategoryForm,
    editingCategoryId,
    loadCategories,
  ]);

  const handleDeleteCategory = useCallback(
    async (category: PodcastSubscriptionCategory) => {
      if (
        !window.confirm(
          `Delete category "${category.name}"? Subscriptions in this category will become uncategorized.`
        )
      ) {
        return;
      }
      setCategoryMutationBusy(true);
      setCategoryMutationError(null);
      try {
        await apiFetch(`/api/podcasts/categories/${category.id}`, { method: "DELETE" });
        if (activeCategoryFilter === category.id) {
          setActiveCategoryFilter("all");
        }
        await Promise.all([loadCategories(), loadSubscriptions(0, false)]);
      } catch (deleteError) {
        if (isApiError(deleteError)) {
          setCategoryMutationError(deleteError.message);
        } else {
          setCategoryMutationError("Failed to delete category");
        }
      } finally {
        setCategoryMutationBusy(false);
      }
    },
    [activeCategoryFilter, loadCategories, loadSubscriptions]
  );

  const handleReorderCategories = useCallback(
    async (reordered: PodcastSubscriptionCategory[]) => {
      const nextIds = reordered.map((category) => category.id);
      const currentIds = categories.map((category) => category.id);
      if (
        nextIds.length === currentIds.length &&
        nextIds.every((categoryId, idx) => categoryId === currentIds[idx])
      ) {
        return;
      }
      const previous = categories;
      setCategories(reordered);
      setCategoryMutationBusy(true);
      setCategoryMutationError(null);
      try {
        const response = await apiFetch<{ data: PodcastSubscriptionCategory[] }>(
          "/api/podcasts/categories/order",
          {
            method: "PUT",
            body: JSON.stringify({ category_ids: nextIds }),
          }
        );
        setCategories(response.data);
      } catch (reorderError) {
        setCategories(previous);
        if (isApiError(reorderError)) {
          setCategoryMutationError(reorderError.message);
        } else {
          setCategoryMutationError("Failed to reorder categories");
        }
      } finally {
        setCategoryMutationBusy(false);
      }
    },
    [categories]
  );

  const openImportModal = useCallback(() => {
    setImportError(null);
    setImportResult(null);
    setImportFile(null);
    setIsImportModalOpen(true);
  }, []);

  const closeImportModal = useCallback(() => {
    setIsImportModalOpen(false);
    setImportBusy(false);
  }, []);

  const handleImportOpml = useCallback(async () => {
    if (!importFile) {
      setImportError("Select an OPML/XML file to import.");
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      const response = await fetch("/api/podcasts/import/opml", {
        method: "POST",
        body: formData,
      });
      const responseBody = (await response.json().catch(() => null)) as
        | { data?: PodcastOpmlImportResult; error?: { message?: string } }
        | null;

      if (!response.ok) {
        const fallbackMessage = "Failed to import OPML file";
        throw new Error(responseBody?.error?.message || fallbackMessage);
      }
      if (!responseBody?.data) {
        throw new Error("Import response missing summary payload");
      }

      setImportResult(responseBody.data);
      await loadSubscriptions(0, false);
    } catch (opmlImportError) {
      if (opmlImportError instanceof Error && opmlImportError.message) {
        setImportError(opmlImportError.message);
      } else {
        setImportError("Failed to import OPML file");
      }
    } finally {
      setImportBusy(false);
    }
  }, [importFile, loadSubscriptions]);

  return (
    <PageLayout
      title="My podcasts"
      description="Manage subscriptions and jump into podcast episode detail."
    >
      <SectionCard title="Plan and quota">
        {planLoading && <StateMessage variant="loading">Loading plan snapshot...</StateMessage>}
        {planError && <StateMessage variant="error">{planError}</StateMessage>}
        {plan && (
          <>
            <p className={styles.planSummary}>
              Plan <strong>{plan.plan.plan_tier}</strong> - window{" "}
              <strong>{plan.plan.initial_episode_window}</strong> episodes - used{" "}
              <strong>{plan.usage.total_minutes}</strong> minutes today
              {plan.usage.remaining_minutes === null
                ? " (unlimited remaining)"
                : ` (${plan.usage.remaining_minutes} remaining)`}
            </p>
            <p className={styles.planSummary}>Plan changes are managed by internal billing controls.</p>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Subscriptions"
        actions={
          <div className={styles.sectionActions}>
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={openCreateCategoryForm}
              aria-label="New category"
            >
              New category
            </button>
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={openImportModal}
              aria-label="Import OPML"
            >
              Import OPML
            </button>
            { }
            <a
              href="/api/podcasts/export/opml"
              download="nexus-podcasts.opml"
              className={styles.secondaryAction}
              aria-label="Export OPML"
            >
              Export OPML
            </a>
            <span>{activeCount} active</span>
          </div>
        }
      >
        <div className={styles.unsubscribeModeRow}>
          <label htmlFor="unsubscribe-mode" className={styles.unsubscribeModeLabel}>
            Unsubscribe behavior
          </label>
          <select
            id="unsubscribe-mode"
            value={String(unsubscribeMode)}
            onChange={(event) => setUnsubscribeMode(Number(event.target.value) as 1 | 2 | 3)}
            className={styles.unsubscribeModeSelect}
            aria-label="Unsubscribe behavior"
          >
            <option value="1">Keep episodes in libraries</option>
            <option value="2">Remove from default library</option>
            <option value="3">Remove from default and single-member libraries</option>
          </select>
        </div>
        <div className={styles.sortRow}>
          <label htmlFor="subscription-sort" className={styles.sortLabel}>
            Subscription sort
          </label>
          <select
            id="subscription-sort"
            value={subscriptionSort}
            onChange={(event) => setSubscriptionSort(event.target.value as SubscriptionSort)}
            className={styles.sortSelect}
            aria-label="Subscription sort"
          >
            <option value="recent_episode">Recent Episode</option>
            <option value="unplayed_count">Most Unplayed</option>
            <option value="alpha">A-Z</option>
          </select>
        </div>

        {categoriesLoading && <StateMessage variant="loading">Loading categories...</StateMessage>}
        {categoriesError && <StateMessage variant="error">{categoriesError}</StateMessage>}
        {categoryMutationError && <StateMessage variant="error">{categoryMutationError}</StateMessage>}

        {categories.length > 0 && (
          <>
            <div className={styles.categoryTabs} role="tablist" aria-label="Subscription categories">
              <button
                type="button"
                className={styles.categoryTab}
                aria-pressed={activeCategoryFilter === "all"}
                onClick={() => setActiveCategoryFilter("all")}
              >
                All
              </button>
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={styles.categoryTab}
                  aria-pressed={activeCategoryFilter === category.id}
                  onClick={() => setActiveCategoryFilter(category.id)}
                >
                  <span className={styles.categoryDot} style={{ color: category.color ?? "transparent" }}>
                    •
                  </span>
                  {category.name} ({category.unplayed_count})
                </button>
              ))}
              <button
                type="button"
                className={styles.categoryTab}
                aria-pressed={activeCategoryFilter === "uncategorized"}
                onClick={() => setActiveCategoryFilter("uncategorized")}
              >
                Uncategorized ({uncategorizedUnplayedCount})
              </button>
            </div>

            <SortableList
              className={styles.categoryManageList}
              itemClassName={styles.categoryManageItem}
              items={categories}
              getItemId={(category) => category.id}
              onReorder={(reorderedCategories) => {
                void handleReorderCategories(reorderedCategories);
              }}
              renderDragOverlay={(category) => (
                <div className={styles.categoryDragOverlay} aria-hidden="true">
                  <span className={styles.categoryDragOverlayHandle}>⋮⋮</span>
                  <span className={styles.categoryManageLabel}>
                    <span className={styles.categoryDot} style={{ color: category.color ?? "transparent" }}>
                      •
                    </span>
                    {category.name}
                  </span>
                </div>
              )}
              renderItem={({ item: category, handleProps, isDragging }) => {
                const dragBindings = categoryMutationBusy
                  ? handleProps.attributes
                  : {
                      ...handleProps.attributes,
                      ...handleProps.listeners,
                    };
                return (
                  <div className={styles.categoryManageRow}>
                    <div className={styles.categoryManageLeft}>
                      <button
                        type="button"
                        className={styles.categoryDragHandle}
                        aria-label={`Reorder category ${category.name}`}
                        aria-grabbed={isDragging ? "true" : "false"}
                        disabled={categoryMutationBusy}
                        {...dragBindings}
                      >
                        ⋮⋮
                      </button>
                      <span className={styles.categoryManageLabel}>
                        <span
                          className={styles.categoryDot}
                          style={{ color: category.color ?? "transparent" }}
                        >
                          •
                        </span>
                        {category.name}
                      </span>
                    </div>
                    <div className={styles.categoryManageActions}>
                      <button
                        type="button"
                        className={styles.secondaryAction}
                        onClick={() => openEditCategoryForm(category)}
                        aria-label={`Edit category ${category.name}`}
                        disabled={categoryMutationBusy}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryAction}
                        onClick={() => void handleDeleteCategory(category)}
                        aria-label={`Delete category ${category.name}`}
                        disabled={categoryMutationBusy}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              }}
            />
          </>
        )}

        {categoryFormOpen && (
          <div className={styles.categoryForm}>
            <label htmlFor="category-name" className={styles.settingsFieldLabel}>
              Category name
            </label>
            <input
              id="category-name"
              className={styles.settingsSelect}
              value={categoryNameInput}
              onChange={(event) => setCategoryNameInput(event.target.value)}
              aria-label="Category name"
            />
            <label htmlFor="category-color" className={styles.settingsFieldLabel}>
              Category color (optional)
            </label>
            <input
              id="category-color"
              className={styles.settingsSelect}
              value={categoryColorInput}
              onChange={(event) => setCategoryColorInput(event.target.value)}
              placeholder="#3366FF"
              aria-label="Category color"
            />
            <div className={styles.categoryFormActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => void handleSaveCategoryForm()}
                disabled={categoryMutationBusy}
                aria-label={categoryFormMode === "create" ? "Create category" : "Save category"}
              >
                {categoryMutationBusy
                  ? "Saving..."
                  : categoryFormMode === "create"
                    ? "Create category"
                    : "Save category"}
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeCategoryForm}
                disabled={categoryMutationBusy}
                aria-label="Cancel category edit"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading && <StateMessage variant="loading">Loading subscriptions...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}

        {!loading && rows.length === 0 && !error && (
          <StateMessage variant="empty">
            No active podcast subscriptions yet. Discover podcasts to subscribe.
          </StateMessage>
        )}

        {rows.length > 0 && (
          <AppList>
            {rows.map((row) => {
              const rowBusy = busyPodcastIds.has(row.podcast_id);
              const rowRefreshing = refreshingPodcastIds.has(row.podcast_id);
              return (
                <AppListItem
                  key={row.podcast_id}
                  href={`/podcasts/${row.podcast_id}`}
                  title={row.podcast.title}
                  description={row.podcast.author || "Unknown author"}
                  meta={
                    row.sync_error_code
                      ? `${row.sync_status} sync - ${row.sync_error_code}: ${row.sync_error_message || "unknown error"}`
                      : `${row.sync_status} sync`
                  }
                  trailing={
                    <span className={styles.trailing}>
                      {row.unplayed_count > 0 && (
                        <span className={styles.unplayedBadge}>{row.unplayed_count} new</span>
                      )}
                      <span className={styles.categoryBadge}>
                        {row.category ? row.category.name : "Uncategorized"}
                      </span>
                      <span className={styles.status}>{row.sync_status}</span>
                    </span>
                  }
                  actions={
                    <label className={styles.categorySelectLabel}>
                      Category
                      <select
                        aria-label={`Category for ${row.podcast.title}`}
                        className={styles.categorySelect}
                        value={row.category?.id ?? ""}
                        onChange={(event) =>
                          void handleAssignCategory(row.podcast_id, event.target.value)
                        }
                        disabled={rowBusy || categoryMutationBusy}
                      >
                        <option value="">Uncategorized</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  }
                  options={[
                    {
                      id: "settings",
                      label: "Settings",
                      disabled: rowBusy,
                      onSelect: () => openSettingsModal(row),
                    },
                    {
                      id: "refresh-sync",
                      label: rowRefreshing ? "Refreshing..." : "Refresh sync",
                      disabled: rowRefreshing,
                      onSelect: () => {
                        void handleRefreshSync(row.podcast_id);
                      },
                    },
                    {
                      id: "unsubscribe",
                      label: rowBusy ? "Unsubscribing..." : "Unsubscribe",
                      tone: "danger",
                      disabled: rowBusy,
                      onSelect: () => {
                        void handleUnsubscribe(row.podcast_id);
                      },
                    },
                  ]}
                />
              );
            })}
          </AppList>
        )}

        {!loading && hasMore && (
          <button
            type="button"
            className={styles.loadMoreButton}
            disabled={loadingMore}
            onClick={() => void loadSubscriptions(nextOffset, true)}
            aria-label="Load more subscriptions"
          >
            {loadingMore ? "Loading..." : "Load more subscriptions"}
          </button>
        )}
      </SectionCard>

      {settingsRow && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={`Subscription settings for ${settingsRow.podcast.title}`}
        >
          <div className={styles.modalCard}>
            <h3 className={styles.modalTitle}>Subscription settings</h3>
            <p className={styles.modalDescription}>
              Configure default playback behavior for <strong>{settingsRow.podcast.title}</strong>.
            </p>
            <label htmlFor="subscription-default-playback-speed" className={styles.settingsFieldLabel}>
              Default playback speed
            </label>
            <select
              id="subscription-default-playback-speed"
              className={styles.settingsSelect}
              value={settingsDefaultSpeed}
              onChange={(event) => setSettingsDefaultSpeed(event.target.value)}
              aria-label="Default playback speed"
            >
              <option value="default">Default (1.0x)</option>
              {SUBSCRIPTION_PLAYBACK_SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={String(speed)}>
                  {formatPlaybackSpeedLabel(speed)}
                </option>
              ))}
            </select>
            <label htmlFor="subscription-category" className={styles.settingsFieldLabel}>
              Subscription category
            </label>
            <select
              id="subscription-category"
              className={styles.settingsSelect}
              value={settingsCategoryId}
              onChange={(event) => setSettingsCategoryId(event.target.value)}
              aria-label="Subscription category"
            >
              <option value="">Uncategorized</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <label className={styles.settingsToggleLabel}>
              <input
                type="checkbox"
                checked={settingsAutoQueue}
                onChange={(event) => setSettingsAutoQueue(event.target.checked)}
                aria-label="Automatically add new episodes to my queue"
              />
              <span>Automatically add new episodes to my queue</span>
            </label>
            <p className={styles.modalDescription}>
              New episodes from this podcast will be added to the end of your playback queue when
              they&apos;re synced.
            </p>
            {settingsError && <StateMessage variant="error">{settingsError}</StateMessage>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => void handleSaveSettings()}
                disabled={settingsBusy}
                aria-label="Save subscription settings"
              >
                {settingsBusy ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeSettingsModal}
                disabled={settingsBusy}
                aria-label="Close subscription settings"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {isImportModalOpen && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="Import OPML">
          <div className={styles.modalCard}>
            <h3 className={styles.modalTitle}>Import OPML</h3>
            <p className={styles.modalDescription}>
              Upload an OPML or XML file to bulk subscribe podcasts.
            </p>
            <label htmlFor="opml-file-input" className={styles.fileLabel}>
              OPML file
            </label>
            <input
              id="opml-file-input"
              type="file"
              accept=".opml,.xml,application/xml,text/xml"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setImportFile(selected);
              }}
              className={styles.fileInput}
              aria-label="OPML file"
            />

            {importError && <StateMessage variant="error">{importError}</StateMessage>}
            {importResult && (
              <div className={styles.importSummary}>
                <p className={styles.importSummaryTitle}>Import complete</p>
                <p>Total found: {importResult.total}</p>
                <p>Imported: {importResult.imported}</p>
                <p>Already subscribed: {importResult.skipped_already_subscribed}</p>
                <p>Invalid/skipped: {importResult.skipped_invalid}</p>
                {importResult.errors.length > 0 && (
                  <ul className={styles.importErrors}>
                    {importResult.errors.map((errorRow, idx) => (
                      <li key={`${errorRow.feed_url ?? "missing-feed"}-${idx}`}>
                        {errorRow.feed_url ? `${errorRow.feed_url}: ` : ""}
                        {errorRow.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className={styles.modalActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => void handleImportOpml()}
                disabled={importBusy || !importFile}
                aria-label="Import"
              >
                {importBusy ? "Importing..." : "Import"}
              </button>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeImportModal}
                aria-label="Close"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  );
}
