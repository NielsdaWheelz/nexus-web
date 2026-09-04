"use client";

import { useEffect } from "react";

// The 2000-01-06 18:14 UTC new moon, and the mean synodic month in days.
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_DAYS = 29.53058867;
const DAY_MS = 86_400_000;
// The grain tile is 320×320; a seed inside one tile covers every arrangement.
const GRAIN_TILE_PX = 320;

/* The Solar's two client-computed variables. Both refine an authored default
   rather than supplying a missing one, so first paint is never wrong and there
   is nothing to hydrate (blueprint L5). --moon is the real lunar phase, from
   arithmetic — no network, no dependency; --grain-seed offsets the one grain
   tile, which is never regenerated (L6). Mount only, no timer: the room does
   not tell the time within a sitting (direction §10 wildcard 3). Both live on
   <html>, and only the elvish block reads them. */
export function SolarEffects() {
  useEffect(() => {
    const age =
      ((((Date.now() - NEW_MOON_EPOCH_MS) / DAY_MS) % SYNODIC_DAYS) +
        SYNODIC_DAYS) %
      SYNODIC_DAYS;
    const illumination = (1 - Math.cos((2 * Math.PI * age) / SYNODIC_DAYS)) / 2;
    const { style } = document.documentElement;
    style.setProperty("--moon", (0.15 + 0.85 * illumination).toFixed(3));
    const seedX = Math.floor(Math.random() * GRAIN_TILE_PX);
    const seedY = Math.floor(Math.random() * GRAIN_TILE_PX);
    style.setProperty("--grain-seed", `${seedX}px ${seedY}px`);
  }, []);

  return null;
}
