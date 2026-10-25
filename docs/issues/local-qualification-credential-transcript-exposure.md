# local qualification credential transcript exposure

status: open · origin: 2026-09-25 latest-model qualification session · area: operator credentials

## problem and evidence

a read-only search of the ignored `deploy/env/env-prod-backend` printed five
credential values into an internal agent tool transcript: one openai key, two
stripe secrets, and an r2 access-key pair. no repository file changed. the
transcript may outlive the local session.
do not copy the values into this ticket or another artifact.

## prerequisite and acceptance

the credential owner determines the transcript's retention boundary and rotates
any affected credentials outside it. confirm replacement credentials work, and
invalidate the exposed values. qualification must use fresh task-scoped local
credentials and avoid reading the protected production env file.

## 2026-10-02 cleanup workflow incident

inspection of `~/.config/skidbladnir/client.json` printed the three peer
`bearer` fields into this session's tool transcript. the redaction filter
covered token/secret/password/credential/auth keys but missed `bearer`. no
credential file changed. no values are copied here.

the skid credential owner determines the transcript's retention boundary and
rotates affected macbook, devbox, and arch peer credentials outside it.
coordinate replacement with active sessions; do not mutate shared auth blindly.
invalidate the exposed credentials and confirm skid connects with replacements.
configuration inspection now uses an explicit nonsecret field allowlist.

## 2026-10-04 library fixture incident

before source edits, psycopg rejected a sqlalchemy-style task dsn and included
its synthetic loopback connection uri in a tool traceback. this was the owned
`nexus-cleanup-library-wire-pg-20261004` database; no production credential/data
or protected env file was involved. no uri or value is copied here. the fixture
now needs driver-compatible scheme handling and exception reporting that cannot
print connection arguments; safe receipts contain only resource metadata.

this synthetic incident is resolved: exact owned container
`30212c78be78` and its private input were removed after the gate passed;
`/tmp/nexus-library-wire-workflow-cleanup.receipt.json` records both absent.
the driver scheme/reporting was corrected before the frozen proof. earlier
production/skid exposures remain open.

## 2026-10-19 disposable setup qualification

a diagnostic tail of the private throwaway supabase start log exposed that
local project's generated credentials to an agent tool transcript. no external
provider or production credentials were involved. raw cli logs/status must not
be printed; subsequent checks used parsed nonsecret summaries.

this synthetic incident is resolved: exact auth project `nexus-substrate-dev`
and compose project of the same name were removed, including auth/app/storage
volumes and networks; private session/key/status/log files were deleted. those
local credentials no longer authorize a running service. prior operator-key
incidents above remain open.

## 2026-10-21 search architecture review

a review subagent's artifact preview printed `openai_api_key` from ignored
`.nexus-local/search-qualification/live.json` into its tool transcript despite
instructions to redact secrets. the value was not copied into parent messages,
new files or network requests. credential-bearing artifact inspection stopped;
the remaining review uses source, issue records and sanitized plans.

the credential owner determines whether transcript retention crosses the intended
trust boundary and rotates the affected key if it does. confirm replacement
access and invalidate the exposed key where rotation is required. do not print
the private config or key when checking resolution.

## 2026-10-23 search attribution metadata

a draft-helper preview exposed one private fixture identifier; a parent receipt
projection also included a request identifier. no corpus text, query, vector or
credential was involved. neither value is repeated here. subsequent inspection
uses closed field allowlists and source fragments that exclude baked fixture
values. this metadata incident adds no credential-rotation requirement; earlier
credential incidents retain their existing owner actions.
