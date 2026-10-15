"use client";

// The dome's interaction host: it turns the sky (0.5°/s, still under reduced
// motion), draws only while its pane is on screen, lets a drag turn the dome and
// turns a tap (< 4 px of travel) into a pick of the nearest star within 22 px.
import { useEffect, useRef } from "react";
import { usePaneIsVisible } from "@/lib/panes/paneRuntime";
import styles from "./atlas.module.css";
import { drawSky, fitCanvas, nearestStar, type Scene, type Star } from "./sky";

const TURN_PER_SECOND = (0.5 * Math.PI) / 180;
const TAU = Math.PI * 2;

export default function SkyCanvas({
  scene,
  onHover,
  onPick,
}: {
  readonly scene: Scene;
  readonly onHover: (star: Star | null) => void;
  readonly onPick: (star: Star | null) => void;
}) {
  const visible = usePaneIsVisible();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const camera = useRef(0);
  const drag = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    lastX: number;
  } | null>(null);
  // Schedules one frame; the loop keeps going only while the sky moves.
  const wake = useRef(() => {});

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d");
    if (!visible || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = 0;
      const still = reduced.matches;
      if (!drag.current && !still && last > 0) {
        camera.current =
          (camera.current + (TURN_PER_SECOND * (now - last)) / 1000) % TAU;
      }
      last = still ? 0 : now;
      const s = fitCanvas(canvas, camera.current);
      drawSky(ctx, s, sceneRef.current, still ? 0 : now / 1000);
      if (!still) raf = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(tick);
    };
    wake.current = schedule;
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas.parentElement!);
    reduced.addEventListener("change", schedule);
    schedule();
    return () => {
      wake.current = () => {};
      cancelAnimationFrame(raf);
      resize.disconnect();
      reduced.removeEventListener("change", schedule);
    };
  }, [visible]);
  useEffect(() => wake.current(), [scene]);

  const hit = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const s = fitCanvas(canvas, camera.current);
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return nearestStar(sceneRef.current.stars, s, x, y, 22);
  };

  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      role="img"
      aria-label="A celestial chart of the whole library"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const { pointerId: pointer, clientX, clientY } = event;
        drag.current = {
          pointer,
          startX: clientX,
          startY: clientY,
          lastX: clientX,
        };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (d?.pointer !== event.pointerId)
          return onHover(hit(event.clientX, event.clientY));
        const turn =
          ((event.clientX - d.lastX) / event.currentTarget.clientWidth) * TAU;
        camera.current = (camera.current - turn + 2 * TAU) % TAU;
        d.lastX = event.clientX;
        wake.current();
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        if (d?.pointer !== event.pointerId) return;
        drag.current = null;
        const travel = Math.hypot(
          event.clientX - d.startX,
          event.clientY - d.startY,
        );
        if (travel < 4) onPick(hit(event.clientX, event.clientY));
      }}
      onPointerCancel={() => (drag.current = null)}
      onPointerLeave={() => {
        drag.current = null;
        onHover(null);
      }}
    />
  );
}
