"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";

/** Retained coordinators publish defects to a descendant feature boundary. */
export default class FeatureErrorBoundary extends Component<{
  scope: "Nexus" | "ReaderProgress" | "ReaderContent" | "Imports";
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
  onRetry(): void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportClientDefect(error, { scope: this.props.scope, componentStack: info.componentStack ?? "" });
  }
  private retry = () => {
    this.props.onRetry();
    this.setState({ failed: false });
  };
  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
