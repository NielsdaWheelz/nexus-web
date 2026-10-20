# lab login continuation is unverified

the disposable browser bootstrap receives password login 303, but its exact
authenticated navigation does not settle. this blocks row-drag qualification;
no behavioral cases ran in these failed invocations.

at `2d480801a`, the content-free trace from
`20261020-004638-71d7775d32e4/browser-bootstrap.log:10-12` records fast refresh
rebuilding/completing and the authenticated main-frame `GET /lectern` failing
with `net::ERR_ABORTED` at 4583ms. lines 19-22 show `/login` committing instead
and the exact canonical-navigation timeout. no same-origin browser api 401
appears; this is development-server reload interference, not evidence that the
reader's credentials were rejected.

the runtime owner is replacing the hmr development server with an ordinary
production build/start. require the strict canonical destination, reader
identity, device cookie and primary nav checks to pass before the live cases
start, then complete the affected browser journeys. no retry or relaxed
destination. temporary trace instrumentation has been removed.
