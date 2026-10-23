"use client";

/** Current view facts authorize new intents; retained commands keep their target. */
import { assertNever } from "@/lib/assertNever";
import { createElement } from "react";
import { ACTION_CATALOG } from "./catalog";
import type { ActionButtonSpec, PodcastActionFocus, PodcastActionSubject } from "./inlineActions";
import { useActionRuntime, type ActionContext } from "./ResourceActionsProvider";
import { projectPodcastLibrariesAction, projectPodcastSubscriptionAction, type ActionCommand } from "./project";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PodcastTarget } from "@/lib/podcasts/api";

function project(subject: PodcastActionSubject, ctx: ActionContext, run: (command: ActionCommand) => void, focus?: PodcastActionFocus) {
  const facts = subject.facts;
  let target: PodcastTarget = subject.target;
  let subscribed = false;
  let reason: string | null = null;
  let subscriptionLabel: string | null = null;
  switch (facts.kind) {
    case "Resolving": reason = "checking subscription…"; subscriptionLabel = reason; break;
    case "Failed": reason = "couldn’t check subscription"; subscriptionLabel = reason; break;
    case "Ready":
      switch (facts.resolution.kind) {
        case "Canonical": target = { kind: "Canonical", podcast_id: facts.resolution.podcast_id }; subscribed = facts.resolution.subscribed; break;
        case "Discovery": break;
        case "Unavailable": subscriptionLabel = "subscription unavailable"; reason = facts.resolution.reason === "NotFound" ? "this podcast is no longer available" : "this podcast discovery target is invalid"; break;
        default: assertNever(facts.resolution);
      }
      break;
    default: assertNever(facts);
  }
  const subscription = projectPodcastSubscriptionAction({ target, title: subject.title, subscribed, disabledReason: reason, ctx, run, focus });
  return [
    { ...subscription, label: subscriptionLabel ?? subscription.label },
    projectPodcastLibrariesAction({ target, title: subject.title, disabledReason: reason, ctx, run, focus }),
  ];
}

export function usePodcastActions(subject: PodcastActionSubject): readonly ActionButtonSpec[] {
  const { ctx, run } = useActionRuntime();
  return project(subject, ctx, run).map<ActionButtonSpec>((action, index) => ({
    controlKey: index === 0 ? "PodcastSubscription" : "PodcastLibraries", id: action.id,
    label: index === 0 ? action.label : "manage libraries", icon: action.icon,
    disabled: action.disabled === true, disabledReason: action.disabledReason ?? null, busy: false, hasPopup: "dialog",
    invoke: focus => { project(subject, ctx, run, focus)[index].onSelect({ triggerEl: focus.trigger, openIntent: "default" }); },
  }));
}

export function usePodcastMenuActions(subject: PodcastActionSubject, focus: PodcastActionFocus): readonly ActionDescriptor[] {
  const { ctx, run } = useActionRuntime();
  const actions: ActionDescriptor[] = project(subject, ctx, run, focus);
  const ready = subject.facts.kind === "Ready" && subject.facts.resolution.kind !== "Unavailable";
  actions.push({ kind: "command", id: "ImportPodcastEpisodes", label: ACTION_CATALOG.ImportPodcastEpisodes.label,
    icon: createElement(ACTION_CATALOG.ImportPodcastEpisodes.icon, { size: 16, "aria-hidden": true }),
    disabled: !ready, disabledReason: ready ? undefined : actions[0].disabledReason, restoreFocusOnClose: false,
    onSelect: () => {
      if (!ready) return;
      const target: PodcastTarget = subject.facts.kind === "Ready" && subject.facts.resolution.kind === "Canonical"
        ? { kind: "Canonical", podcast_id: subject.facts.resolution.podcast_id } : subject.target;
      const trigger = focus.trigger;
      ctx.overlays.open({ kind: "ImportPodcastEpisodes", target, title: subject.title },
        { anchor: () => trigger, returnFocusFallback: focus.returnFocus });
    },
  });
  const facts = subject.facts;
  if (facts.kind === "Failed") actions.push({ kind: "command", id: "RetryPodcastFacts", label: "retry checking subscription", disabled: facts.retrying, onSelect: facts.retry });
  return actions;
}
