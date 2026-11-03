# inbound capture sharing

this module owns android system shares and the standalone `/share` surface.
[resource sharing](resource-sharing.md) owns grants and anonymous reading;
[imports](imports.md) owns intake commands, line states and recovery.

## native payload

`ShareActivity.kt` receives text and ordered `EXTRA_STREAM` uris from `ACTION_SEND`
or `ACTION_SEND_MULTIPLE`. `ClipData` carries grants, not another copy of the file
list. pdf and epub shares use the file filters; plain text uses single send.
an empty recognized share reaches the web empty state.

the activity retains its capture id, account, date and uri list. its owned
`GET /_nexus/shared/manifest` returns indexed name, size and mime metadata, including
an empty array for text-only shares. absent metadata is explicit null. each
`GET /_nexus/shared/{index}` transfers a content-resolver stream to the webview;
the web intake creates the file and owns upload and confirmation. these routes
require the current wire and never cache. main and hosted browsers answer404.

only `content:` uris are read. other schemes retain their index with null metadata
and answer404 at the stream route. denied, missing or unavailable streams likewise
answer404; failure after a stream starts remains a transport failure. metadata
failure does not remove an entry or establish stream readability. the activity
copies no file, takes no persistent grant and owns no uploader.

rotation retains the activity, webview and intake. task/process death does not
retain an upload command or extend a receiver grant; a later resend may create
another file import. capture identity/date retain their existing restoration
contract for authored plain text.

## admission and exits

`ShareCapture.tsx` mounts the ordinary intake without host truth, menus or slips.
manifest200 alone authorizes automatic admission into all. main/browser404 keeps
an explicit import press; visiting a share link admits nothing. named-library
selection and a separate capture queue are absent. each command retains the
ordinary acquisition/removal-fence contract and its own uncertainty.

files disable plain-text capture. urls in accompanying text remain import inputs;
other prose is discarded. unreadable entries stay as refused lines. only an
all-accepted set closes the actual share activity; failed or unknown lines stay.
browser/main completion uses its ordinary done state.

without files or urls, plain text uses the existing authored daily-capture command.
actual shares retain their native capture id and account-local date. browser/main
require `add to today`; retries retain the original command and date. profile
failure admits nothing. this flow has no media destination picker.

`nexus-share://open`, `done` and `dismiss` belong only to the actual share activity.
finishing asks the existing work guard; the native chrome client supplies real
javascript confirmations. asynchronous exit replies belong to the same live view
and resume generation. sign-in opens main through its existing auth owner and
retains the card; account replacement retires the old document. main/browser
manual cards use ordinary workspace destinations, not activity callbacks.
