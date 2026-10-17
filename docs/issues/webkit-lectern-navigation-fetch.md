# webkit lectern reread can escape during navigation

status: open; cause unassigned
origin: 2026-10-16 pr #655 integration campaign, source `41221d947`
area: web / lectern read lifetime

the webkit direct-close/manager journey completed its interaction assertions,
then failed its page-error assertion: `Fetch API cannot load` the local
`/api/lectern/suggestions` `due to access control checks`. the trace names an
`onReconnect` callback while leaving the previous lectern fixture. the harness
keeps its error assertion; an affected replay does not erase this observation.

impact: a read may reject outside its owner during navigation. product cause
versus teardown remains unresolved. the related existing workspace-save
observation is [separate](../tickets/webkit-workspace-session-navigation-error.md);
their causes have not been shown equal.

do: reproduce with the request, navigation and subscription lifetime captured;
repair the responsible read owner if it can outlive its view. do not add a
palette-specific transport fallback or suppress browser exceptions.

done: establish a pure harness/teardown cause, or reproduce and repair the
product cause with no uncaught rejection on the same real navigation.
