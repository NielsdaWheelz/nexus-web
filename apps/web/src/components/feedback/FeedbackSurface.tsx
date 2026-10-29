"use client";

import { useState, type ReactNode } from "react";
import { FeedbackScope } from "./Feedback";
import FeedbackLayer from "./FeedbackLayer";
import type { FeedbackHost } from "./scope";

/** Mount the one passive layer in the real host, preserving its overlay context. */
export default function FeedbackSurface({ children, ...host }: Omit<FeedbackHost, "layer"> & { children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  return <FeedbackScope host={{ ...host, layer }}>{children}<FeedbackLayer ref={setLayer} /></FeedbackScope>;
}
