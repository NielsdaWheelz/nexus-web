# lab starts can race the host stack limit

problem: a docker count before starting a lab cannot see another invocation
still acquiring images. independent checkouts can exceed the owner's two-stack
host limit despite checking immediately before each start.

evidence: on 2026-10-21, collection run `193055-c1bbcc65f19f` checked one live
stack, then overlapped `193054-d9dabcf435f0` starting and `192514-c8f1ea645acb`
still running. collection sent its own runtime sigint; normal teardown removed
its stack. no other session was stopped.

impact: transient excess host load and delayed qualification. the host-budget
coordinator owns the pending admission fix; collection loading adds no host
framework. collection qualification uses an explicit coordinator reservation;
this prevents its remaining starts from racing but does not prove atomic host
admission.

resolved when: host-wide admission reserves capacity before service creation
and concurrent live starts across checkouts stay within two owned stacks.
