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
