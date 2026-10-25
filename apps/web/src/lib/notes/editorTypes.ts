/** Ephemeral editor values and selection callbacks. They are never a persistence
 * protocol: bound editors translate displayed transactions into Yjs deltas. */
import type { NoteBody } from "@nexus/authored/body";
export interface TextEditBase { value: NoteBody | string; acknowledged: { value: NoteBody | string; version: number } | null }
export interface NoteEdit { editBase?: TextEditBase; before: NoteBody; after: NoteBody; selectionBefore: { anchor: number; head: number }; selectionAfter: { anchor: number; head: number }; source: "input" | "composition" | "paste" | "format" | "attachment" }
export type FocusSelection = { anchor: number; head: number; direction?: "forward" | "backward" | "none" } | "end";
export type OutlineCommand = "insert" | "indent" | "outdent" | "move_up" | "move_down" | "undo" | "redo";
export interface OutlineCommandState { enabled: boolean; reason: string | null }
