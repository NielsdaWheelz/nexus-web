"use client";
// Side-effect import: ensures OracleLandingPaneBody is bundled with the /oracle
// route so the controlled-textarea chunk is available during hydration — prevents
// React from overwriting the filled input with the component's empty initial state.
import "./OracleLandingPaneBody";

export default function Page() {
  return null;
}
