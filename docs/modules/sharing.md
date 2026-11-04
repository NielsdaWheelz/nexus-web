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

## main document routing

main opens owned `/share` targets as standalone documents, preserving their query
and fragment. crossing either way from a current app document asks its existing
`nexus:request-exit` work guard before loading. intents, main-frame get links and
popups use the same route owner. cold entry loads directly; workspace-to-workspace
app links keep the existing `nexus:navigate` acknowledgement and hello redelivery.
main still answers 404 for shared payload routes and never admits a capture by
virtue of its shell identity. custom-tab authentication retains the active
document; its existing challenge and callback owners do not navigate it.

one activity-local sequence identifies each admitted app-route request, including
successive requests for the same uri. delivery and guard replies must still own
that sequence, pending uri and document generation. a standalone request is
consumed on approval, denial or failed checking; an unhandled workspace delivery
remains pending for its mounted command owner. page start advances document
identity without discarding retained app links.

native back first offers escape to the current document. an unconsumed press
asks the document guard when current or previous native history is `/share`, or
when an owned document has no history. the reply must still match the captured
document, pending request and current/history destination. only the final
accepted traversal or delegated exit clears that captured pending request,
immediately before issuing the action. escape consumption, denial and failure
retain it; a newer request or changed history makes the old reply inert. an
acknowledgement during a back check can therefore require another press. history
traversal keeps its native owner; a later veto does not restore an old pending
request or trigger an automatic retry.

## main file chooser

main opens the system chooser with `ACTION_GET_CONTENT`, `CATEGORY_OPENABLE` and
type `*/*`. it splits and trims web accept entries, retaining mime types for
`EXTRA_MIME_TYPES`; extension suffixes are omitted. an empty mime list leaves that
extra absent, preserving the unrestricted connections picker. only
`MODE_OPEN_MULTIPLE` sets `EXTRA_ALLOW_MULTIPLE`.

the existing result callback returns every actual `clipData` uri in order, or
the single `data` uri when no clip data exists. cancellation returns null. a new
chooser request, unavailable activity or activity destruction retires the pending
callback with null. the web input and ordinary intake retain file admission;
native code neither reads nor uploads selected files.
