# extension capture

the firefox toolbar and x share row add one source to personal all. the popup is
a receipt: published title/authors, immediate library edits and reviewed removal.
there is no save step, destination draft, import selector or manual replacement.

owners: `apps/web/src/extension/background.ts` owns the memory-only operation;
`capture.ts` owns local messages and state; `nexusClient.ts` decodes the versioned
api; `content.ts` extracts from a pinned document; `xShare.ts` binds x's share menu;
`popup.tsx` presents the receipt. server admission/publication is
[ingest](ingest.md); memberships/removal use their canonical application writers.

## admission

`default_popup` suppresses `browserAction.onClicked`. the popup launch controller
connects passively and sends opening once after actual native focus. firefox can
execute it speculatively on mouse-down: mounting/visibility cannot admit a save.
programmatic operation/account presentation takes precedence over toolbar opening.
direct attachment consumes the same one-shot transition; reconnect only attaches.

pin the initiating window, tab, exact source url and native document/frame before
auth, permissions or network work. x also pins its selected permalink. extraction
checks the document and spa route again. completed bytes no longer need the page.
changing tabs cannot retarget an admitted operation.

the x adapter has standing access only to x.com, twitter.com and mobile.twitter.com.
it pins the owning item before native pointer/key activation opens the portal,
excludes nested quote links, and inserts one `add to nexus` row. the active
trigger's `aria-expanded`/`aria-controls` relation identifies the menu; source and
menu ownership are checked again before submission. observation ends when that
relation or source changes. the background independently validates
sender/frame/host/target; page scripts never receive credentials or general commands.

## ownership

one unresolved mutation owns its account, input, uuid and frozen guards. closure
detaches the view. accepted url admission, confirmed upload or acknowledged default
retention releases it; upload-session creation/put does not. same-target duplicate
admission attaches while unresolved; another target gets a busy refusal. every
asynchronous result retains its operation/account binding.

readable exact targets retain personal all without extraction or a source refresh.
failed/pending targets without readable content get a new fenced attempt on the
same media. exact source ambiguity refuses. title/content similarity never decides
identity. source errors do not revoke acknowledged saving.

credentials alone persist. restart loses unconfirmed bytes/requests and never
replays them. unknown writes retain exact retry; forgetting explicitly concedes
that the write may have committed. account changes cannot replay an old account's
command. disconnect lives in the toolbar context menu and refuses unresolved work.

## receipt controls

use the published copy's ordered author credits and title. before any readable
copy, use only the bound observed preview/byline. omit unknown authors. physical
default retention differs from effective all membership; settlement uses the former.
library changes are absolute versioned writes through the shared placement owner.
the picker retains query/focus/scroll while editing is temporarily disabled.
receipt reads cannot start or publish while a command runs, including its
preflight. successful commands refresh afterward; refusals retain their frozen
checks and guards until an explicit read or new choice.

whole-workspace removal fetches its acquisition revision before review. a later
explicit add/filing, including a no-op, invalidates that review. an unavailable
read does not prove an unanswered mutation failed. removal preserves notes and
highlights; progress and other readers' access can be lost. it is not undo.
