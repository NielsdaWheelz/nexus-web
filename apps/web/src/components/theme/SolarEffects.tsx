"use client";

import { useEffect } from "react";

const NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
const SYNODIC_DAYS = 29.53058867;

/**
 * The Solar's two client variables on <html>, set once per mount and read
 * only by the elvish room: `--moon`, the real lunar illumination (0.15 new to
 * 1 full; authored at 1, so first paint is never wrong), and `--grain-seed`, an
 * offset into the one 320px grain tile, so the stars land somewhere new each
 * visit and then never move.
 */
export function SolarEffects() {
  useEffect(() => {
    const days = (Date.now() - NEW_MOON_MS) / 86_400_000;
    const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
    const illumination = (1 - Math.cos((2 * Math.PI * age) / SYNODIC_DAYS)) / 2;
    const { style } = document.documentElement;
    style.setProperty("--moon", (0.15 + 0.85 * illumination).toFixed(3));
    style.setProperty(
      "--grain-seed",
      `${Math.floor(Math.random() * 320)}px ${Math.floor(Math.random() * 320)}px`,
    );
  }, []);
  return null;
}
