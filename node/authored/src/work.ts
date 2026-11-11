/** Work belongs to a note. Designation, task completion and each habit date
 * merge independently; conversion never translates or removes completion facts.
 * Null patch fields leave existing state alone. False checks remain tombstones. */
import type { LocalDate, NoteWork, Register, Stamp, WorkDesignation, WorkView } from "./types.ts";
import { WorkConversionError } from "./types.ts";
import { counter, mergeRegister } from "./merge.ts";

export type WorkIntent =
  | { kind: "set_work_designation"; ref: string; designation: WorkDesignation }
  | { kind: "set_task_completion"; ref: string; local_date: LocalDate | null; today: LocalDate }
  | { kind: "set_habit_completion"; ref: string; local_date: LocalDate; completed: boolean; today: LocalDate }
  | { kind: "clear_work_day"; ref: string; local_date: LocalDate }
  | { kind: "restore_work_designation"; ref: string; expected: Stamp; designation: WorkDesignation }
  | { kind: "restore_task_completion"; ref: string; expected: Stamp; local_date: LocalDate | null }
  | { kind: "restore_habit_completion"; ref: string; expected: Stamp; local_date: LocalDate; completed: boolean };

export function validateLocalDate(value: LocalDate): void {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) || value.startsWith("0000-")) throw new TypeError("Expected a YYYY-MM-DD civil date");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new TypeError("Invalid civil date");
}

export function mergeWork(old: NoteWork | null, patch: NoteWork | null): NoteWork | null {
  if (patch === null) return old;
  const habit_checks: Record<LocalDate, Register<boolean>> = {...old?.habit_checks};
  for (const [date, check] of Object.entries(patch.habit_checks)) habit_checks[date] = mergeRegister(habit_checks[date] ?? null, check)!;
  const captured = old === null || counter(patch.captured.lamport) < counter(old.captured.lamport) ||
    patch.captured.lamport === old.captured.lamport && patch.captured.replica_id < old.captured.replica_id ? patch.captured : old.captured;
  return {captured, designation: mergeRegister(old?.designation ?? null, patch.designation)!,
    task_completed_on: mergeRegister(old?.task_completed_on ?? null, patch.task_completed_on), habit_checks};
}

export function projectWork(work: NoteWork | null): WorkView | null {
  if (work === null) return null;
  return {captured: work.captured, designation: work.designation.value, task_completed_on: work.task_completed_on?.value ?? null,
    habit_dates: Object.entries(work.habit_checks).filter(([, check]) => check.value).map(([date]) => date).sort()};
}

function sameStamp(current: Stamp | undefined, expected: Stamp): boolean {
  return current?.lamport === expected.lamport && current.replica_id === expected.replica_id;
}

/** Preconditions apply once to the observed local state. Retry merges this
 * frozen patch, including its date, rather than rerunning the gesture. */
export function prepareWorkPatch(work: NoteWork | null, action: WorkIntent, stamp: Stamp): NoteWork | null {
  const register = <T>(value: T): Register<T> => ({value, stamp});
  if (action.kind === "set_work_designation") {
    if (work === null && !action.designation.enabled) return null;
    if (work !== null) {
      if (action.designation.kind !== work.designation.value.kind &&
        (work.task_completed_on !== null && work.task_completed_on.value !== null || Object.values(work.habit_checks).some(check => check.value))) throw new WorkConversionError();
      if (action.designation.kind === work.designation.value.kind && action.designation.enabled === work.designation.value.enabled) return null;
    }
    return {captured: work?.captured ?? stamp, designation: register(action.designation), task_completed_on: null, habit_checks: {}};
  }
  if (work === null) throw new TypeError("designate this note before recording work");
  const patch: NoteWork = {captured: work.captured, designation: work.designation, task_completed_on: null, habit_checks: {}};
  switch (action.kind) {
    case "set_task_completion": {
      validateLocalDate(action.today);
      if (action.local_date !== null) {
        validateLocalDate(action.local_date);
        if (action.local_date > action.today) throw new TypeError("choose today or an earlier date");
      }
      if ((work.task_completed_on?.value ?? null) === action.local_date) return null;
      return {...patch, task_completed_on: register(action.local_date)};
    }
    case "set_habit_completion": {
      validateLocalDate(action.local_date); validateLocalDate(action.today);
      if (action.completed && action.local_date > action.today) throw new TypeError("choose today or an earlier date");
      if ((work.habit_checks[action.local_date]?.value ?? false) === action.completed) return null;
      return {...patch, habit_checks: {[action.local_date]: register(action.completed)}};
    }
    case "clear_work_day": {
      validateLocalDate(action.local_date);
      const task = work.task_completed_on?.value === action.local_date;
      const habit = work.habit_checks[action.local_date]?.value === true;
      if (!task && !habit) return null;
      return {...patch, task_completed_on: task ? register(null) : null,
        habit_checks: habit ? {[action.local_date]: register(false)} : {}};
    }
    case "restore_work_designation":
      return sameStamp(work.designation.stamp, action.expected) ? {...patch, designation: register(action.designation)} : null;
    case "restore_task_completion":
      if (action.local_date !== null) validateLocalDate(action.local_date);
      return sameStamp(work.task_completed_on?.stamp, action.expected) ? {...patch, task_completed_on: register(action.local_date)} : null;
    case "restore_habit_completion":
      validateLocalDate(action.local_date);
      return sameStamp(work.habit_checks[action.local_date]?.stamp, action.expected) ? {...patch, habit_checks: {[action.local_date]: register(action.completed)}} : null;
  }
}
