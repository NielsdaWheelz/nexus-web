"use client";

import { Fragment, useState } from "react";
import type { Schema } from "@/lib/api/wire";
import { formatDisplayDate } from "@/lib/display/format";
import { shiftLocalDate } from "@/lib/localDate";
import { pluralize } from "@/lib/text/pluralize";
import { recordDate, recordTime } from "@/lib/consumption/recordText";
import { fnv1a, rng } from "./material";
import styles from "./Slip.module.css";

export function Stamp({ day, large = false, stamped = false }: {
  day: Schema<"DayOut">;
  large?: boolean;
  stamped?: boolean;
}) {
  if (day.active_ms === 0) return null;
  const turn = (rng(fnv1a(day.date))() - 0.5) * 9;
  return <span className={styles.stamp} data-level={day.level} data-large={large || undefined}
    data-stamped={stamped || undefined} aria-hidden="true" style={{ rotate: `${turn}deg` }}>
    {day.level === 0 ? "·" : large ? formatDisplayDate(day.date,
      { displayLocale: "en-GB", displayTimeZone: "UTC" }, { day: "numeric", month: "short" })!.toUpperCase() : null}
  </span>;
}

/** The calendar is entirely the account's civil dates; the browser contributes no day. */
export default function Slip({ slip, today, firstDay }: {
  slip: Schema<"SlipOut">;
  today: string;
  firstDay: string | null;
}) {
  const year = today.slice(0, 4);
  const days = new Map(slip.days.map(day => [day.date, day]));
  const todayLevel = days.get(today)?.level ?? 0;
  const [seen, setSeen] = useState({ slip, today, level: todayLevel, stamped: false });
  if (seen.slip !== slip) setSeen({ slip, today, level: todayLevel,
    stamped: seen.today === today && seen.level === 0 && todayLevel > 0 });
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = shiftLocalDate(today, -((weekday + 6) % 7));
  const weeks = [monday];
  for (let week = shiftLocalDate(monday, -7); week.slice(0, 4) === year; week = shiftLocalDate(week, -7)) weeks.push(week);
  return <section className={styles.slip} aria-label="days read">
    <header className={styles.head}><span>days read</span><span>{year}</span></header>
    <div className={styles.figures}>
      {slip.weeks_running > 0 ? <p className={styles.running}><strong>{slip.weeks_running}</strong> {slip.weeks_running === 1 ? "week" : "weeks"} running</p> : null}
      <p>{pluralize(slip.days_read, "day")} read · {pluralize(slip.weeks_entire, "week")} entire</p>
    </div>
    <table className={styles.table}>
      <caption className="sr-only">days read in {year}</caption>
      <thead className="sr-only"><tr><th scope="col">week</th>
        {["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map(day => <th key={day} scope="col">{day}</th>)}
        <th scope="col">observed time</th></tr></thead>
      <tbody>{weeks.map((week, index) => {
        const dates = Array.from({ length: 7 }, (_, day) => shiftLocalDate(week, day));
        const counted = dates.filter(date => (days.get(date)?.level ?? 0) > 0).length;
        const active = dates.reduce((sum, date) => sum + (days.get(date)?.active_ms ?? 0), 0);
        return <Fragment key={week}>
          <tr className={index === 0 ? styles.current : undefined} data-entire={counted === 7 || undefined}>
            <th scope="row">{index === 0 ? "this week" : formatDisplayDate(week,
              { displayLocale: "en", displayTimeZone: "UTC" }, { day: "numeric", month: "short" })!.toLowerCase()}</th>
            {dates.map(date => {
              const day = days.get(date) ?? { date, active_ms: 0, level: 0, finished: 0 };
              const text = `${date}, ${recordTime(day.active_ms)}`;
              return <td key={date} title={text} data-level={day.level}
                data-off={date > today || firstDay !== null && date < firstDay || undefined}>
                <span className="sr-only">{text}</span>
                {index === 0 ? <span className={styles.weekday} aria-hidden="true">{formatDisplayDate(date,
                  { displayLocale: "en", displayTimeZone: "UTC" }, { weekday: "short" })!.toLowerCase()}</span> : null}
                <Stamp day={day} large={index === 0} stamped={date === today && seen.stamped} />
                {index === 0 && date === today && day.level === 0 ? <span className={styles.today} aria-hidden="true">today</span> : null}
                {day.finished > 0 ? <span className={styles.finish} aria-label={`${pluralize(day.finished, "work")} finished`} /> : null}
                {index === 0 && day.active_ms > 0 ? <span className={styles.time} aria-hidden="true">{recordTime(day.active_ms)}</span> : null}
              </td>;
            })}
            <td className={styles.sum}>{active > 0 ? recordTime(active) : null}</td>
          </tr>
          {index === 0 ? <tr className={styles.note}><td colSpan={9}>{counted === 7 ? "a week entire." : `${counted} of 7 so far.`}</td></tr> : null}
        </Fragment>;
      })}</tbody>
    </table>
    <p className={styles.foot}>{firstDay !== null ? `recording began ${recordDate(firstDay)}. ` : null}a stamp for each day of five minutes or more; darker ink, longer reading.</p>
  </section>;
}
