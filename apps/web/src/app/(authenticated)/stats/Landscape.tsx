"use client";

import { useId } from "react";
import type { Schema } from "@/lib/api/wire";
import { pluralize } from "@/lib/text/pluralize";
import { ridge, stretch } from "./landscapeGeometry";
import styles from "./Landscape.module.css";

/** The work's places own all geometry; the cursor marks a place, never inferred coverage. */
export default function Landscape({ work, title, compact, strip = false, finished = false }: {
  work: Schema<"WorkRecordOut">;
  title: string;
  compact: boolean;
  strip?: boolean;
  finished?: boolean;
}) {
  const id = useId();
  const height = strip ? compact ? 22 : 28 : compact ? 132 : 204;
  const range = strip ? [0, 1] as const : stretch(work.units, work.position);
  const [a, b] = range;
  const whole = a === 0 && b === 1;
  const units = work.units.filter(unit => unit.end > a && unit.start < b);
  const noun = work.unit?.toLowerCase() ?? "unit";
  const position = work.position;
  const current = position === null ? null : work.units.findLast(unit => unit.start <= position);
  const part = units[0]?.part;
  const partName = !whole && part !== null && part !== undefined && units.every(unit => unit.part === part)
    && work.units.filter(unit => unit.part === part).length === units.length
    ? work.parts[part] : null;
  const caption = units.length === 0 ? null : `${partName !== null ? `${partName}: ` : ""}${pluralize(units.length, noun)}${!whole && partName === null ? " around your place" : ""}, each ${work.unit === "Page" ? "as tall as its text" : "as wide and as tall as it is long"}.${!whole ? ` beneath, the whole of ${title}.` : ""}`;
  const covered = finished ? [[0, 1]] : work.covered;
  const ranges: [number, number][] = [];
  const ahead: [number, number][] = [];
  let at = a;
  for (const [start, end] of covered) {
    const left = Math.max(a, start), right = Math.min(b, end);
    if (right <= left) continue;
    if (left > at) ahead.push([at, left]);
    ranges.push([left, right]);
    at = right;
  }
  if (at < b) ahead.push([at, b]);
  const { near, middle, far } = ridge({ mediaId: work.media.media_id, units: work.units, range, width: 1000, height });
  const area = (values: Float32Array) => `M0,${height}${Array.from(values, (value, x) => `L${x},${(height - value).toFixed(1)}`).join("")}L1000,${height}Z`;
  const crest = `M${Array.from(near, (value, x) => `${x},${(height - value).toFixed(1)}`).join("L")}`;
  const px = (place: number) => Math.max(0, Math.min(1000, (place - a) / (b - a) * 1000));
  const marker = work.position !== null && !finished ? px(work.position) : null;
  const labelX = current === null || current === undefined ? null : Math.max(0, Math.min(100, ((current.start + current.end) / 2 - a) / (b - a) * 100));
  const sentence = `${title}: ${pluralize(units.length, noun)} drawn to scale${work.position !== null ? `, read to ${Math.round(work.position * 100)}%` : ""}`;
  return <figure className={styles.landscape} data-strip={strip || undefined} data-finished={finished || undefined}>
    <div role="img" aria-label={sentence} className={styles.drawing} style={{ height: `${height + (strip ? 0 : 12)}px` }}>
      <svg aria-hidden="true" focusable="false" viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" style={{ height }}>
        <defs>
          {[{ name: "far", values: far, foot: 0.12 }, { name: "middle", values: middle, foot: 0.22 }, { name: "near", values: near, foot: 0.5 }].map(layer => <linearGradient
            key={layer.name} id={`${id}-${layer.name}`} gradientUnits="userSpaceOnUse"
            x1="0" y1={height - Math.max(...layer.values)} x2="0" y2={height} className={styles[layer.name]}>
            <stop offset="0" /><stop offset="1" stopOpacity={layer.foot} />
          </linearGradient>)}
          {[{ name: "read", intervals: ranges }, { name: "ahead", intervals: ahead }].map(group => <clipPath key={group.name} id={`${id}-${group.name}`}>
            {group.intervals.map(([left, right]) => <path key={left} d={`M${px(left)},0H${px(right)}V${height}H${px(left)}Z`} />)}
          </clipPath>)}
        </defs>
        {units.length > 0 ? [{ name: "ahead", read: false }, { name: "read", read: true }].map(group => <g key={group.name}
          clipPath={`url(#${id}-${group.name})`} className={group.read ? styles.read : styles.ahead} data-finished={finished || undefined}>
          {[{ name: "far", values: far }, { name: "middle", values: middle }, { name: "near", values: near }].map(layer =>
            <path key={layer.name} d={area(layer.values)} fill={`url(#${id}-${layer.name})`} className={styles.wash} />)}
          <path d={crest} className={styles.ridge} vectorEffect="non-scaling-stroke" />
        </g>) : <>
          <path d={`M0,${height - 1}H1000`} className={styles.ground} vectorEffect="non-scaling-stroke" />
          {ranges.map(([left, right]) => <path key={left} d={`M${px(left)},${height - 1}H${px(right)}`} className={styles.coveredGround} vectorEffect="non-scaling-stroke" />)}
        </>}
      </svg>
      {marker !== null ? <span className={styles.marker} aria-hidden="true"
        style={{ left: `${marker / 10}%`, height: `${height - near[Math.round(marker)] + (strip ? 0 : 12)}px` }} /> : null}
    </div>
    {!strip && units.length > 0 ? <div className={styles.axis} aria-hidden="true">
      {units.map(unit => <span key={unit.start} className={styles.tick} style={{ left: `${px(unit.start) / 10}%` }} />)}
      <span className={styles.tick} style={{ left: "100%" }} />
      {current !== null && current !== undefined && labelX !== null ? <span className={styles.label} data-edge={labelX < 20 ? "start" : labelX > 80 ? "end" : undefined}
        style={{ left: `${labelX}%` }}>{current.label ?? "the opening"}</span> : null}
    </div> : null}
    {strip && work.parts.length > 0 ? <div className={styles.parts} aria-hidden="true">
      {work.parts.map((name, partIndex) => {
        const first = work.units.find(unit => unit.part === partIndex);
        return first === undefined ? null : <span key={partIndex} title={name} style={{ left: `${first.start * 100}%` }}>
          {roman(partIndex + 1)}
        </span>;
      })}
    </div> : null}
    <ul className="sr-only">{units.map(unit => <li key={unit.start}>{unit.label ?? "the opening"}: {finished || work.covered.some(([start, end]) => start < unit.end && end > unit.start) ? "read" : "ahead"}</li>)}</ul>
    {!strip && !whole ? <div className={styles.whole}>
      <Landscape work={work} title={title} compact={compact} strip finished={finished} />
      <span className={styles.bracket} aria-hidden="true" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />
    </div> : null}
    {!strip && caption !== null ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
  </figure>;
}

function roman(value: number): string {
  let numeral = "";
  for (const [amount, sign] of [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]] as const) {
    while (value >= amount) { numeral += sign; value -= amount; }
  }
  return numeral;
}
