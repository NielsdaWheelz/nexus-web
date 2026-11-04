# committed context can stay absent until reload

an already-open chat context can omit a locally committed attachment or link until reload. `ChatContext.tsx:54,127` reads server context and refetches on composer completion; `ResourceComposer.tsx:99,137,155` completes the local command, while `useConnectionAttachments.tsx:162` links without that refresh. a local commit need not yet appear in the server projection.

own refresh at the actual admission boundary without weakening local durability. resolve with ordinary existing-item, composed-note and file attachment paths, including delayed upload: the same open context must show the admitted item without reload. exact membership and reload identity checks do not prove live refresh.
