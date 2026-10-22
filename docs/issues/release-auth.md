# remaining auth release acceptance

production api and hosted web shipped `99320b630` on 2026-10-22. their issuer and
audience configuration pair was verified, the production c2 email census passed,
and the published jwks uses asymmetric signing. the installed `android-v0.3.5`
upgrade preserved its authenticated session and passed scoped app-link routing.
these checks establish the configuration pair, census and retained-session routing.

remaining checks are `NOT_RUN`:

- read the provider's `jwt_expiry` setting and confirm it exceeds 120 seconds;
  the web renews within that interval, so a shorter expiry refreshes every navigation.
- if the post room is configured, verify `EMAIL_INGEST_OWNER_USER_ID` identifies
  the owner and `GET /me` exposes the address only to that account; its separate
  activation record is [post room](production-post-room-unconfigured.md).

keep the signing-key rotation rule: publish a new key as standby for over an hour
before rotation, matching the api jwks cache. `docs/modules/auth.md` owns auth.
delete this record once the remaining provider checks are recorded.
