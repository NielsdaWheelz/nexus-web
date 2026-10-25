"use client";

/** Current view facts authorize new intents; retained commands keep their target. */
import { installedApp } from "@/lib/native/admission";
import { createElement } from "react";
import { ACTION_CATALOG } from "./catalog";
import type { ActionButtonSpec, PodcastActionFocus, PodcastActionSubject } from "./inlineActions";
import { useActionRuntime, type ActionContext } from "./ResourceActionsProvider";
import { projectConsumptionUndoActions, projectPodcastLibrariesAction, projectPodcastSubscriptionAction, type ActionCommand } from "./project";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PodcastTarget } from "@/lib/podcasts/api";

function project(subject: PodcastActionSubject, ctx: ActionContext, run: (command: ActionCommand) => void, focus?: PodcastActionFocus) {
  const facts = subject.facts;
  const subscription = projectPodcastSubscriptionAction({ target: subject.target, title: subject.title, facts, disabledReason: null, ctx, run, focus });
  const target: PodcastTarget = facts.kind === "Ready" && facts.resolution.kind === "Canonical"
    ? { kind: "Canonical", podcast_id: facts.resolution.podcast_id } : subject.target;
  return [
    subscription,
    { ...projectPodcastLibrariesAction({ target, title: subject.title, disabledReason: subscription.disabledReason ?? null, ctx, run, focus }),
      accessibleLabel: `manage libraries: ${subject.title}` },
  ];
}

export function usePodcastActions(subject: PodcastActionSubject): readonly ActionButtonSpec[] {
  const { ctx, run } = useActionRuntime();
  return project(subject, ctx, run).map<ActionButtonSpec>((action, index) => ({
    controlKey: index === 0 ? "PodcastSubscription" : "PodcastLibraries", id: action.id,
    menuLabel: action.label, accessibleLabel: action.accessibleLabel, icon: action.icon,
    disabled: action.disabled === true, disabledReason: action.disabledReason ?? null, busy: false, hasPopup: "dialog",
    invoke: focus => { project(subject, ctx, run, focus)[index].onSelect({ triggerEl: focus.trigger, openIntent: "default" }); },
  }));
}

export function usePodcastMenuActions(subject: PodcastActionSubject, focus: PodcastActionFocus): readonly ActionDescriptor[] {
  const { ctx, run } = useActionRuntime();
  const actions: ActionDescriptor[] = project(subject, ctx, run, focus);
  const disconnected = installedApp && !ctx.online;
  const ready = !disconnected && subject.facts.kind === "Ready" && subject.facts.resolution.kind !== "Unavailable";
  actions.push({ kind: "command", id: "ImportPodcastEpisodes", label: ACTION_CATALOG.ImportPodcastEpisodes.label,
    icon: createElement(ACTION_CATALOG.ImportPodcastEpisodes.icon, { size: 16, "aria-hidden": true }),
    disabled: !ready, disabledReason: ready ? undefined : actions[0].disabledReason, restoreFocusOnClose: false,
    onSelect: () => {
      if (!ready) return;
      const target: PodcastTarget = subject.facts.kind === "Ready" && subject.facts.resolution.kind === "Canonical"
        ? { kind: "Canonical", podcast_id: subject.facts.resolution.podcast_id } : subject.target;
      const trigger = focus.trigger;
      run({ ref: `podcast:${target.kind === "Canonical" ? target.podcast_id : target.target}`, id: "ImportPodcastEpisodes",
        label: ACTION_CATALOG.ImportPodcastEpisodes.label, title: subject.title, tracked: false, confirmation: null,
        execute: () => ctx.overlays.open({ kind: "ImportPodcastEpisodes", target, title: subject.title },
          { anchor: () => trigger, returnFocusFallback: focus.returnFocus }),
      });
    },
  });
  const facts = subject.facts;
  if (facts.kind === "Failed") actions.push({ kind: "command", id: "RetryPodcastFacts", label: "retry checking subscription", disabled: facts.retrying, onSelect: facts.retry });
  if (facts.kind === "Ready" && facts.resolution.kind === "Canonical") actions.push(...projectConsumptionUndoActions({ kind: "Podcast", podcast_id: facts.resolution.podcast_id }, ctx));
  return actions;
}
