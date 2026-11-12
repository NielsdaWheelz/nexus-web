# lab ingress addresses after proxy restart

`docker/docker-compose.lab-codex.yml:40` restarts the ingress proxy automatically,
but lines 49–50 publish native/control ports with docker-selected host ports.
`docker/docker-compose.lab-owned.yml:26` inherits that proxy. a proxy restart can
therefore leave an attached mac api using obsolete endpoints until its lab restarts.
native host retirement leaves this separate proxy alive; production uses unix sockets.

the native-recovery fake-host journey observed this docker behavior directly:
control/native ports changed from 54952/54951 to 55150/55149 after one container
restart. fake-host composition now reserves explicit ports; the inherited proxy
case remains a source-derived follow-up, not a tested failure.

resolve by assigning stable published ports at each lab ingress owner and checking
that an attached client recovers through the same addresses after proxy restart.
shared installation changes require its explicit drain/reinstall workflow.
