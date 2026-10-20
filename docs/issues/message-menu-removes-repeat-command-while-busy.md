# message menu removes a repeat command while busy

status: implementation repaired; chat-specific live qualification remains open.

original problem: `MessageFooter` omitted its repeat-with command while the
underlying command was disabled, changing membership during temporary busy state.

current source: `components/chat/MessageFooter.tsx` retains an eligible repeat-with
row, propagates availability and publishes complete prepared content. source
review passes. the isolated catalog returns 503 before a real chat can be admitted;
see [runtime prerequisite](disposable-runtime-generation-catalog-unavailable.md).
page/nexus and real podcast availability checks do not establish the chat path.

resolved when relevant busy transitions retain command membership and order,
current availability blocks dispatch, and recovery permits the current command.
the menu stays open only when displayed meaning and geometry remain unchanged;
a changed reason or layout must close it before activation.
