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
