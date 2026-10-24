# local web tls cutover

the canonical standalone web package serves tls/http2 only. `make web` now uses
build/restart. existing plain-http local origins and certificates must be updated
before using it; vercel still owns its separate managed production frontend edge.

owner steps:

- provide a pem certificate chain and key through `NEXUS_WEB_TLS_CERT_FILE` and
  `NEXUS_WEB_TLS_KEY_FILE`; keep private keys outside committed files. the leaf
  must cover the public hostname and clients must trust its issuer normally.
- set `APP_PUBLIC_URL` to the exact https origin. `make web` defaults to
  `https://127.0.0.1:3000` and binds loopback; packaged startup additionally
  requires `PORT` and `HOSTNAME`. restart after changing either certificate.
- replace explicit old http overrides in web, api/worker and extension settings;
  their configuration boundaries now reject them.
- align supabase's site url and exact `/auth/callback` allowlist, the extension
  origin and any android build origin with that same https origin. restart local
  supabase after updating its committed configuration.
- android debug uses that loopback origin through `adb reverse tcp:3000 tcp:3000`.
  provide its debug-only ca through `nexusAndroidDebugCaFile`; normal android
  certificate verification stays enabled. its auth custom tab is a separate
  browser and needs normal trust for that same issuer. release trust is unchanged.
- qualify the packaged edge with `node .next/standalone/probe-web.mjs
  <https-origin> <ca-file>` from `apps/web`, authenticated browser requests and
  concurrent live streams plus an ordinary reader request. verify h2 negotiation,
  http/1 rejection and complete owned teardown. no certificate bypass or native
  trust-policy weakening is part of this cutover.
- verify actual http2 negotiation on the managed production edge separately;
  local http/1 rejection does not establish vercel's serving policy.

resolved when the owner provisions the chosen local certificate/trust and the
canonical runtime passes those checks. no deployed host was changed here.
