# restored title-only page cannot publish its first body

at `3942b8fd2`, private run `20261021-124029-3695898bc692`, the title-only new
page survives checkpoint, pane close, recovery and fixed-id reopen. entering its
first rich body then produces no page publication request within ten seconds.

preserve its original publication context through recovery and route adoption;
opening must remain inert, but a new committed body edit must admit publication.
resolved when that journey publishes once under the original page/note/link ids
and retains the same editor, caret and newer input.
