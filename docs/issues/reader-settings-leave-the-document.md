# reader settings leave the document

problem: the reader view menu's "Reader settings" replaces the document with the
settings pane by default
(`apps/web/src/app/(authenticated)/media/[id]/chrome.tsx:98-104`, disposition
`Follow`; on mobile it is always a full navigation). font size, line height and
column width are adjusted without the text they affect, then compared from memory.

impact: typography tuning is blind trial and error. only a shift-click fork keeps
the text visible on desktop.

proposed fix: an in-place "Aa" popover anchored to the reader header (a dialog, not
a menu, because it holds native ranges), reusing one extracted reader-appearance
form shared with `settings/reader/SettingsReaderPaneBody.tsx`, with a sheet variant on
mobile. the view menu's theme choice stays. header placement keeps the media
header's compact control budget (history, identity, more, inspector).

resolved when every reader profile field can be adjusted from the reader while the
text it changes stays visible, on desktop and mobile.
