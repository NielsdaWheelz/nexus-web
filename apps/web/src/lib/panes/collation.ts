import type { ComponentProps, ReactNode, Ref } from "react";
import type { Line, Verbs } from "@/components/feedback/stage";
import type { PaneFilterRowsStatus } from "@/lib/panes/paneFilterRows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type * as Icon from "@/lib/ui/icons";

export interface PaneCollation {
  readonly words: CollationWords | null;
  readonly dimensions: readonly CollationDimension[];
  readonly order: CollationOrder | null;
  readonly reset: (() => void) | null;
}
export interface CollationOption {
  readonly value: string;
  readonly label: string;
  readonly sign: Icon.Glyph | null;
  readonly count: number | null;
  readonly reason: string | null;
}
interface Choosable {
  readonly id: string;
  readonly label: string;
  readonly rest: string;
  readonly restCount?: number;
  readonly options: readonly CollationOption[];
  readonly aside?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
}
/** Every selected value has a corresponding option; order values likewise name a published way. */
export type CollationDimension =
  | (Choosable & { readonly kind: "One"; readonly value: string | null; readonly onChange: (value: string | null) => void })
  | (Choosable & { readonly kind: "Many"; readonly values: readonly string[]; readonly onChange: (values: readonly string[]) => void })
  | { readonly kind: "Span"; readonly id: string; readonly label: string; readonly unit: string; readonly value: string; readonly backward: boolean; readonly forward: boolean;
      readonly onStep: (by: -1 | 1) => void; readonly now: { readonly label: string; readonly go: () => void } | null;
      readonly pick: { readonly value: string; readonly max: string; readonly onPick: (date: string) => void } | null };
export interface CollationOrder {
  readonly value: string | null;
  readonly rest: string;
  readonly keys: readonly { readonly label: string; readonly ways: readonly { readonly value: string; readonly label: string | null; readonly word: string }[] }[];
  readonly onChange: (value: string | null) => void;
  readonly note: string | null;
}
export interface CollationWords {
  readonly label: string;
  readonly value: string;
  readonly applied: string;
  readonly onChange: (value: string) => void;
  readonly onClear: (intent: "Clear" | "Close") => void;
  /** An entry delivery asks the shell to open this source’s field. */
  readonly requestOpen?: boolean;
  readonly standing: boolean;
  readonly onSubmit: (() => void) | null;
  readonly rows: { readonly status: PaneFilterRowsStatus; readonly announce: boolean } | null;
  readonly notice: { readonly kind: "Refused" | "Ready"; readonly line: Line; readonly verbs?: Verbs } | null;
  readonly verbs: readonly ActionDescriptor[];
  readonly input?: Ref<HTMLInputElement>;
  readonly field?: Pick<ComponentProps<"input">, "onKeyDown" | "onCompositionStart" | "onCompositionEnd" | "role" | "aria-autocomplete" | "aria-expanded" | "aria-controls" | "aria-activedescendant" | "aria-keyshortcuts">;
}

export function dimensionWord(dimension: CollationDimension): string {
  if (dimension.kind === "Span") return dimension.value;
  if (dimension.kind === "One") return dimension.value === null ? dimension.rest : dimension.options.find(option => option.value === dimension.value)!.label;
  const labels = dimension.values.map(value => dimension.options.find(option => option.value === value)!.label);
  return labels.length === 0 ? dimension.rest : labels.length <= 2 ? labels.join(", ") : `${labels[0]} +${labels.length - 1}`;
}
export function orderWord(order: CollationOrder): string {
  return order.value === null ? order.rest : order.keys.flatMap(key => key.ways).find(way => way.value === order.value)!.word;
}
export function litWords(collation: PaneCollation): readonly string[] {
  const words = collation.dimensions.flatMap(dimension =>
    (dimension.kind === "Span" ? dimension.now !== null : dimension.kind === "One" ? dimension.value !== null : dimension.values.length > 0)
      ? [dimensionWord(dimension)] : []);
  if (collation.order?.value !== null && collation.order !== null) words.push(orderWord(collation.order));
  return words;
}
