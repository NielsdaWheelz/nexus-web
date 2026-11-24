"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Ruling } from "@/components/feedback/Ruling";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { formatDay, isLocalDate, shiftLocalDate } from "@/lib/localDate";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import type { WorkspaceNavigationResult } from "@/lib/workspace/store";
import * as Icon from "@/lib/ui/icons";
import styles from "./journalDates.module.css";

const FIRST_DAY = "0001-01-01";
const LAST_DAY = "9999-12-31";
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function weekday(date: string): number {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function monthEnd(month: string): number {
  const end = new Date(`${month}-01T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return end.getUTCDate();
}

function inMonth(date: string, month: string): string {
  return `${month}-${String(Math.min(Number(date.slice(8)), monthEnd(month))).padStart(2, "0")}`;
}

function adjacentMonth(month: string, delta: number): string {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  const first = date.toISOString().slice(0, 10);
  return isLocalDate(first) ? first.slice(0, 7) : month;
}

export default function JournalDates({ readingDate, today, directory, choose, dismiss, returnFocusTo }: {
  readingDate: string;
  today: string | null;
  directory: { dates: readonly string[] | null; error: unknown | null; pending: boolean; retry(): void };
  choose(date: string): WorkspaceNavigationResult;
  dismiss(): void;
  returnFocusTo: ReturnFocusTarget;
}) {
  const [focused, setFocused] = useState(readingDate);
  const [exact, setExact] = useState(readingDate);
  const grid = useRef<HTMLTableElement>(null);
  const moveFocus = useRef(false);
  const leaving = useRef(false);
  const monthLabel = useId();
  const exactLabel = useId();
  const year = focused.slice(0, 4);
  const month = focused.slice(0, 7);
  const monthNumber = focused.slice(5, 7);
  const recorded = useMemo(() => new Set(directory.dates), [directory.dates]);
  const recordedYears = useMemo(() => [...new Set(directory.dates?.map(date => date.slice(0, 4)))], [directory.dates]);
  const years = recordedYears.includes(year) ? recordedYears : [year, ...recordedYears].sort().reverse();
  const offset = weekday(`${month}-01`);
  const days = monthEnd(month);
  const selected = 'button[tabindex="0"]';

  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(selected)?.focus();
  }, [focused]);

  const open = (date: string) => {
    // The store can publish the destination in choose(), retiring this overlay.
    leaving.current = true;
    const result = choose(date);
    leaving.current = result !== "cancelled";
    if (result !== "cancelled") dismiss();
  };

  const move = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    let delta: number | null = null;
    let next = date;
    switch (event.key) {
      case "PageUp":
      case "PageDown":
        next = inMonth(date, adjacentMonth(month, event.key === "PageUp" ? -1 : 1));
        break;
      case "ArrowLeft": delta = -1; break;
      case "ArrowRight": delta = 1; break;
      case "ArrowUp": delta = -7; break;
      case "ArrowDown": delta = 7; break;
      case "Home": delta = -weekday(date); break;
      case "End": delta = 6 - weekday(date); break;
      default: return;
    }
    event.preventDefault();
    if (delta !== null) {
      next = shiftLocalDate(date, delta);
      if (!isLocalDate(next)) next = delta < 0 ? FIRST_DAY : LAST_DAY;
    }
    if (next !== date) {
      moveFocus.current = true;
      setFocused(next);
    }
  };

  return <Dialog open title="go to date" className={styles.dialog} onClose={dismiss}
    initialFocus={panel => panel.querySelector(selected)} returnFocusTo={returnFocusTo} skipReturnFocus={() => leaving.current}>
    <div className={styles.calendar}>
      <div className={styles.monthControls}>
        <Button iconOnly icon={<Icon.Left />} aria-label="previous month" disabled={month === FIRST_DAY.slice(0, 7)}
          onClick={() => setFocused(inMonth(focused, adjacentMonth(month, -1)))} />
        <Select aria-label="month" value={monthNumber} onChange={event => setFocused(inMonth(focused, `${year}-${event.target.value}`))}>
          {MONTHS.map((name, index) => <option key={name} value={String(index + 1).padStart(2, "0")}>{name}</option>)}
        </Select>
        <Select aria-label="year" value={year} onChange={event => setFocused(inMonth(focused, `${event.target.value}-${monthNumber}`))}>
          {years.map(value => <option key={value} value={value}>{value}</option>)}
        </Select>
        <Button iconOnly icon={<Icon.Right />} aria-label="next month" disabled={month === LAST_DAY.slice(0, 7)}
          onClick={() => setFocused(inMonth(focused, adjacentMonth(month, 1)))} />
      </div>
      <span id={monthLabel} className="sr-only" aria-live="polite">{MONTHS[Number(monthNumber) - 1]} {year}</span>
      <table className={styles.grid} ref={grid} role="grid" aria-labelledby={monthLabel}>
        <thead><tr>{WEEKDAYS.map(day => <th key={day} scope="col" aria-label={day}>{day.slice(0, 3)}</th>)}</tr></thead>
        <tbody>
          {Array.from({ length: Math.ceil((offset + days) / 7) }, (_, week) => <tr key={week}>
            {WEEKDAYS.map((weekday, column) => {
              const number = week * 7 + column - offset + 1;
              if (number < 1 || number > days) return <td key={weekday} />;
              const date = `${month}-${String(number).padStart(2, "0")}`;
              const seen = recorded.has(date);
              const reading = date === readingDate;
              return <td key={weekday} aria-selected={reading || undefined}>
                <button type="button" className={styles.day} aria-current={today === date ? "date" : undefined}
                  aria-label={formatDay(date, null) + (reading ? ", reading date" : "") + (seen ? ", recorded day" : "")}
                  data-recorded={seen || undefined} tabIndex={focused === date ? 0 : -1} onFocus={() => setFocused(date)}
                  onKeyDown={event => move(event, date)} onClick={() => open(date)}>
                  <time dateTime={date}>{number}</time>
                </button>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
      {directory.dates !== null ? <p className={styles.legend}><span className={styles.mark} aria-hidden="true" /> recorded day</p> : null}
      <AuthoredReadFailure {...directory} noun="recorded dates" />
      {directory.dates === null && directory.error === null ? <Ruling /> : null}
      <form className={styles.exact} onSubmit={event => {
        event.preventDefault();
        if (isLocalDate(exact)) open(exact);
      }}>
        <label className="sr-only" htmlFor={exactLabel}>exact date</label>
        <Input id={exactLabel} value={exact} placeholder="yyyy-mm-dd" autoComplete="off" spellCheck={false}
          onChange={event => setExact(event.target.value)} />
        <Button type="submit" disabled={!isLocalDate(exact)}>go</Button>
        {today === null ? null : <Button onClick={() => open(today)}>today</Button>}
      </form>
    </div>
  </Dialog>;
}
