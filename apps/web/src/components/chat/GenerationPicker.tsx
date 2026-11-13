"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { useListBox, useListBoxSection, useOption } from "react-aria/useListBox";
import { Item } from "react-stately/Item";
import { Section } from "react-stately/Section";
import { useListState, type ListState } from "react-stately/useListState";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import PickerSurface from "@/components/ui/PickerSurface";
import { ControlContents } from "@/components/ui/control";
import type { ServerValue } from "@/lib/api/serverState";
import {
  catalogRoute,
  choiceUnavailable,
  chooseModel,
  chooseThinking,
  editorRoute,
  editorVariant,
  MODEL_UNAVAILABLE,
  modelKeyOf,
  modelVariants,
  routeKey,
  unreadyReason,
  type ModelVariant,
  type Route,
  type SelectionEditor,
} from "@/lib/chat/selection";
import type { Catalog } from "@/lib/chat/wire";
import { revealCollectionItem } from "@/lib/ui/collection";
import * as Icon from "@/lib/ui/icons";
import { wasOverlayInvokedByTouch } from "@/lib/ui/overlay";
import { usePointerGesture } from "@/lib/ui/pointerGesture";
import collection from "@/components/ui/Collection.module.css";
import styles from "./GenerationPicker.module.css";

type ModelOption = {
  id: string;
  label: string;
  unavailable_reason: string | null;
} & ({ route: Route; variant: ModelVariant } | { route: null; variant: null });
type ProviderSection = { id: string; label: string; reason: string | null; options: ModelOption[] };

/** One exact model/effort choice. Navigation never commits; effort changes keep the panel open. */
export default function GenerationPicker({ catalogRead, value, onChange, waiting, unavailable, returnFocus }: {
  catalogRead: ServerValue<Catalog>;
  value: SelectionEditor;
  onChange(value: SelectionEditor): void;
  waiting: boolean;
  unavailable: string | null;
  returnFocus(): void;
}) {
  const [open, setOpen] = useState(false);
  const [pressSize, setPressSize] = useState<{ width: number; height: number } | null>(null);
  usePointerGesture({ enabled: true, onComplete: () => setPressSize(null) });
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const focusReplacement = useRef(false);
  const skipReturn = useRef(false);
  const touch = useRef(false);
  const id = useId();
  const catalog = catalogRead.status === "ready" ? catalogRead.data : null;
  const route = editorRoute(value);
  const routeRow = catalog && route ? catalogRoute(catalog, route) : null;
  const variant = catalog ? editorVariant(catalog, value) : null;
  const sections: ProviderSection[] = catalog?.routes.map(row => ({
    id: routeKey(row.route),
    label: row.label,
    reason: row.readiness.kind === "Ready" ? null : unreadyReason(row.readiness),
    options: modelVariants(row).map(item => ({
      id: JSON.stringify([routeKey(row.route), item.key]),
      label: item.mode === null ? item.model.label : `${item.model.label} · ${item.reasoning[0].mode_label}`,
      unavailable_reason: row.readiness.kind !== "Ready" ? unreadyReason(row.readiness)
        : item.reasoning.some(choice => choice.chat_state.kind === "Selectable") ? null : choiceUnavailable(item.reasoning[0]),
      route: row.route,
      variant: item,
    })),
  })) ?? [];
  const selectedId = value.kind === "Uninitialized" ? null
    : JSON.stringify([route ? routeKey(route) : null, variant?.key ?? JSON.stringify(value)]);
  if (catalog && selectedId !== null && !sections.some(section => section.options.some(option => option.id === selectedId))) {
    const modelKey = value.kind === "Selected" ? modelKeyOf(value.selection)
      : value.kind === "DefaultUnavailable" ? value.model_key : null;
    const knownModel = routeRow?.models.find(model => model.key === modelKey);
    const missing: ModelOption = {
      id: selectedId,
      label: knownModel ? `${knownModel.label} · mode unavailable` : modelKey ?? "model unavailable",
      unavailable_reason: routeRow && routeRow.readiness.kind !== "Ready" ? unreadyReason(routeRow.readiness) : MODEL_UNAVAILABLE,
      route: null,
      variant: null,
    };
    const section = sections.find(section => section.id === (route ? routeKey(route) : null));
    if (section) section.options.unshift(missing);
    else sections.unshift({
      id: route ? routeKey(route) : "unknown provider",
      label: route?.kind === "ProviderApi" ? route.provider : route?.kind === "CodexPersonal" ? "Codex" : "unknown provider",
      reason: route ? "this provider isn’t available now." : MODEL_UNAVAILABLE,
      options: [missing],
    });
  }
  const options = sections.flatMap(section => section.options);
  const current = options.find(option => option.id === selectedId);
  const choices = variant?.reasoning.filter(choice => choice.chat_state.kind === "Selectable") ?? [];
  const currentKey = value.kind === "Selected" ? value.selection.reasoning : null;
  const effort = value.kind === "Selected" && modelKeyOf(value.selection) === variant?.model.key
    ? variant.reasoning.find(choice => choice.key === currentKey) ?? null : null;
  const fixed = effort !== null && variant?.reasoning.length === 1;
  const index = choices.findIndex(choice => choice.key === currentKey);
  const ladder = JSON.stringify(choices.map(choice => choice.key));
  const busy = waiting || catalogRead.status === "loading" || (catalogRead.status === "failed" && catalogRead.retrying);
  const cold = waiting || catalog === null;
  const effortLabel = effort?.effort_label ?? "effort unavailable";
  const native = catalog?.routes.find(row => row.route.kind === "CodexPersonal");
  const state = useListState<ModelOption>({
    children: sections.map(section => <Section key={section.id} title={section.label}>
      {section.options.map(option => <Item key={option.id} textValue={option.label}>{option.label}</Item>)}
    </Section>),
    selectionMode: "single",
    selectionBehavior: "toggle",
    disallowEmptySelection: true,
    allowDuplicateSelectionEvents: true,
    selectedKeys: selectedId === null ? [] : [selectedId],
    disabledKeys: options.filter(option => option.unavailable_reason !== null).map(option => option.id),
    onSelectionChange: keys => {
      if (keys === "all") return;
      const key = keys.values().next().value;
      if (key === selectedId) { setOpen(false); return; }
      const option = options.find(option => option.id === key);
      if (!catalog || !option || option.variant === null) return;
      const next = chooseModel(catalog, option.route, option.variant.model.key, option.variant.mode, value);
      onChange(next);
      if (next.kind !== "Selected") return;
      skipReturn.current = !touch.current;
      setOpen(false);
      if (!touch.current) returnFocus();
    },
  });
  const { listBoxProps } = useListBox({
    "aria-label": "model",
    autoFocus: false,
    escapeKeyBehavior: "none",
    shouldSelectOnPressUp: true,
    shouldFocusOnHover: true,
  }, state, list);
  const setRange = useCallback((node: HTMLInputElement | null) => {
    if (node === null && range.current === document.activeElement) focusReplacement.current = true;
    range.current = node;
  }, []);
  useLayoutEffect(() => {
    const key = state.selectionManager.focusedKey;
    if (key === null || options.some(option => option.id === key && option.unavailable_reason === null)) return;
    const ownedFocus = state.selectionManager.isFocused;
    state.selectionManager.setFocusedKey(null);
    if (ownedFocus) list.current?.focus();
  });
  useLayoutEffect(() => {
    if (!focusReplacement.current) return;
    focusReplacement.current = false;
    const content = panel.current;
    if (!open || !content || (document.activeElement !== document.body && !content.contains(document.activeElement))) return;
    (range.current ?? content.querySelector<HTMLElement>("[data-effort-choice]") ?? list.current)?.focus({ preventScroll: true });
  });
  // Complete only the committed unresolved intent. An exact choice is never normalized.
  useLayoutEffect(() => {
    if (!catalog || value.kind !== "DefaultUnavailable") return;
    const next = chooseModel(catalog, value.route, value.model_key, value.mode, value);
    if (next.kind === "Selected") onChange(next);
  }, [catalog, value, onChange]);
  const show = () => {
    if (open) return;
    touch.current = wasOverlayInvokedByTouch();
    skipReturn.current = false;
    setOpen(true);
    if (catalogRead.status === "ready") void (catalogRead.error ? catalogRead.refetch() : catalogRead.revalidate());
    else if (catalogRead.status === "failed" && !catalogRead.retrying) void catalogRead.refetch();
  };
  return <>
    <button ref={trigger} type="button" className={styles.trigger}
      style={pressSize ? { minInlineSize: pressSize.width, minBlockSize: pressSize.height } : undefined}
      aria-label={cold ? "model" : `model and effort: ${current?.label ?? "model unavailable"}, ${effortLabel}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} aria-busy={busy || undefined}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary) return;
        // A focus-triggered recall may shorten the label before this press clicks.
        const { width, height } = event.currentTarget.getBoundingClientRect();
        setPressSize({ width, height });
      }}
      onClick={event => { event.stopPropagation(); if (open) setOpen(false); else show(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.repeat && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); event.stopPropagation(); show();
        }
      }}>
      <span className={styles.model}>
        {!cold && unavailable !== null ? <Icon.Warning size={16} aria-hidden="true" className={styles.warning} /> : null}
        {cold ? "model" : current?.label ?? "model unavailable"}
      </span>
      <span className={styles.effortValue}>
        {!cold ? <>
          {!fixed && index >= 0 && choices.length > 1 ? <Icon.Effort size={16} aria-hidden="true" position={index / (choices.length - 1)} /> : null}
          {effortLabel}
        </> : null}
        <span className={styles.chevron}><ControlContents busy={busy} icon={<Icon.Choose size={12} aria-hidden="true" />} /></span>
      </span>
    </button>
    <PickerSurface active={open} onClose={() => setOpen(false)} anchor={() => trigger.current}
      skipReturnFocus={() => skipReturn.current} title="model and effort" panelId={id} placement="above" className={styles.surface}
      slipContent={list}
      initialFocus={surface => {
        const target = current?.unavailable_reason === null ? current : options.find(option => option.unavailable_reason === null);
        state.selectionManager.setFocused(true);
        state.selectionManager.setFocusedKey(target?.id ?? null);
        return [...surface.querySelectorAll<HTMLElement>("[data-choice-id]")].find(element => element.dataset.choiceId === target?.id) ?? list.current ?? surface;
      }}>
      <div ref={panel} className={styles.panel}>
        {catalogRead.status === "loading" ? <Ruling />
          : catalogRead.status === "failed" ? <Failed error={catalogRead.error} noun="models" retry={{ run: catalogRead.refetch, busy: catalogRead.retrying }} />
          : <>
            <ul {...listBoxProps} ref={list} className={collection.compactViewport} data-collection-viewport=""
              onKeyDown={event => { if (event.key !== "Tab") listBoxProps.onKeyDown?.(event); }}
              onKeyDownCapture={event => {
                if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "Tab")) {
                  event.stopPropagation(); return;
                }
                if (event.repeat && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); }
              }}>
              {sections.map(section => <Models key={section.id} section={section} state={state} />)}
            </ul>
            {options.length === 0 ? <p className={styles.reason}>no chat models available.</p> : null}
            {fixed ? null : <div className={styles.effort} role="group" aria-label="effort">
              {effort && choiceUnavailable(effort) ? <p className={styles.reason}>{choiceUnavailable(effort)}</p> : null}
              {index >= 0 && choices.length > 1 ? <div className={styles.rail}>
                <input key={ladder} ref={setRange} type="range" min={0} max={choices.length - 1} step={1}
                  value={index} aria-label="effort" aria-valuetext={choices[index].effort_label}
                  onChange={event => {
                    const choice = choices[Number(event.currentTarget.value)];
                    if (route && variant && choice) onChange(chooseThinking(route, variant.model.key, choice.key));
                  }} />
                <div className={styles.stops} aria-hidden="true">
                  {choices.map((choice, position) => <span key={choice.key} data-current={position === index || undefined}>{choice.effort_label}</span>)}
                </div>
              </div> : choices.length > 0 ? <div className={styles.choices}>
                {choices.map(choice => <button type="button" data-effort-choice="true" key={choice.key}
                  onClick={() => {
                    focusReplacement.current = panel.current?.contains(document.activeElement) === true;
                    if (route && variant) onChange(chooseThinking(route, variant.model.key, choice.key));
                  }}>{choice.effort_label}</button>)}
              </div> : <p className={styles.reason}>{variant ? choiceUnavailable(variant.reasoning[0]) ?? "effort unavailable" : "model unavailable"}</p>}
            </div>}
            {native && native.readiness.kind !== "Ready" ? <div className={styles.footer}><Fact
              line={{ fact: `${native.label}: ${unreadyReason(native.readiness)}` }}
              verbs={[{ label: "retry", commandKey: "read model catalog", run: catalogRead.refetch, busy: catalogRead.refreshing }]} /></div> : null}
          </>}
      </div>
    </PickerSurface>
  </>;
}

function Models({ section, state }: { section: ProviderSection; state: ListState<ModelOption> }) {
  const heading = <>{section.label}{section.reason ? <> · {section.reason}</> : null}</>;
  const { itemProps, headingProps, groupProps } = useListBoxSection({ heading });
  return <li {...itemProps}>
    <div {...headingProps} className={styles.heading}>{heading}</div>
    <ul {...groupProps} className={styles.group}>
      {section.options.map(option => <ModelRow key={option.id} option={option} state={state} />)}
    </ul>
  </li>;
}

function ModelRow({ option, state }: { option: ModelOption; state: ListState<ModelOption> }) {
  const ref = useRef<HTMLLIElement>(null);
  const { optionProps, labelProps, descriptionProps, isFocused, isSelected } = useOption({ key: option.id }, state, ref);
  useLayoutEffect(() => {
    const item = ref.current;
    const viewport = item?.closest<HTMLElement>("[data-collection-viewport]");
    if (isFocused && item && viewport) revealCollectionItem(viewport, item);
  }, [isFocused]);
  return <li {...optionProps} ref={ref} data-choice-id={option.id} data-active={isFocused || undefined} data-selected={isSelected || undefined} className={collection.row}
    onKeyDown={event => {
      optionProps.onKeyDown?.(event);
      // Closing restores focus before native activation; the same key must not reopen the trigger.
      if (event.key === "Enter" || event.key === " ") event.preventDefault();
    }}>
    <span className={collection.content}>
      <span {...labelProps}>{option.label}</span>
      {option.unavailable_reason ? <span {...descriptionProps} className={collection.detail}>{option.unavailable_reason}</span> : null}
    </span>
    {isSelected ? <Icon.Check size={16} aria-hidden="true" className={collection.adornment} /> : null}
  </li>;
}
