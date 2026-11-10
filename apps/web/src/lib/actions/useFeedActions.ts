"use client";

/** Current view facts authorize new intents; retained commands keep their target. */
import { createElement } from "react";
import * as Icon from "@/lib/ui/icons";
import type { ActionButtonSpec, FeedActionFocus, FeedActionSubject } from "./inlineActions";
import { useActionRuntime, type ActionContext } from "./ResourceActionsProvider";
import { projectConsumptionUndoActions, projectFeedLibrariesAction, projectFeedSubscriptionAction, type ActionCommand } from "./project";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { FeedTarget } from "@/lib/feeds/api";


function project(subject: FeedActionSubject, ctx: ActionContext, run: (command: ActionCommand) => void, focus?: FeedActionFocus) {
  const facts = subject.facts;
  const subscription = projectFeedSubscriptionAction({ target: subject.target, feedKind: subject.feedKind, title: subject.title, facts, disabledReason: null, ctx, run, focus });
  const target: FeedTarget = facts.kind === "Ready" && facts.resolution.kind === "Canonical"
    ? { kind: "Canonical", feed_id: facts.resolution.feed_id } : subject.target;
  return [
    subscription,
    { ...projectFeedLibrariesAction({ target, feedKind: subject.feedKind, title: subject.title, disabledReason: subscription.disabledReason ?? null, ctx, run, focus }),
      accessibleLabel: `Add to library: ${subject.title}` },
  ];
}

export function useFeedActions(subject: FeedActionSubject): readonly ActionButtonSpec[] {
  const { ctx, run } = useActionRuntime();
  return project(subject, ctx, run).map<ActionButtonSpec>((action, index) => ({
    controlKey: index === 0 ? "FeedSubscription" : "FeedLibraries", id: action.id,
    menuLabel: action.label, accessibleLabel: action.accessibleLabel, icon: action.icon,
    disabled: action.disabled === true, disabledReason: action.disabledReason ?? null, waiting: action.waiting === true, busy: false, hasPopup: "dialog",
    invoke: focus => { project(subject, ctx, run, focus)[index].onSelect({ triggerEl: focus.trigger, openIntent: "default" }); },
  }));
}

export function useFeedMenuActions(subject: FeedActionSubject, focus: FeedActionFocus): readonly ActionDescriptor[] {
  const { ctx, run } = useActionRuntime();
  const actions: ActionDescriptor[] = project(subject, ctx, run, focus);
  const facts = subject.facts;
  if (facts.kind === "Failed") actions.push({ kind: "command", id: "RetryFeedFacts", label: "check subscription again", icon: createElement(Icon.Again, { "aria-hidden": true }), busy: facts.retrying, onSelect: facts.retry });
  if (facts.kind === "Ready" && facts.resolution.kind === "Canonical") actions.push(...projectConsumptionUndoActions({ kind: "Feed", feed_id: facts.resolution.feed_id, feed_kind: facts.resolution.feed_kind }, ctx));
  return actions;
}
