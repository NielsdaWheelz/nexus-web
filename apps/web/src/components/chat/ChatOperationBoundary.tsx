"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import type { CommandDefect } from "@/lib/chat/commands";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";

type Props = { failure: CommandDefect; paneId: string; visitId: string; fallback: ReactNode };
class OperationBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("chat operation failed:", error);
    reportClientDefect(error, { paneId: this.props.paneId, visitId: this.props.visitId, componentStack: info.componentStack ?? "" });
  }
  render() { return this.state.failed ? this.props.fallback : <FailedOperation error={this.props.failure.error} />; }
}
function FailedOperation({ error }: { error: unknown }): never { throw error; }

/** Only the operation's result crashes. Its input, receipt and transcript live outside. */
export default function ChatOperationBoundary(props: Props) {
  return <OperationBoundary key={props.failure.occurrence} {...props} />;
}
