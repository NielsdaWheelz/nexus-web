# native hierarchy reads can exit 137

an owned api35 emulator's combined pre-auth dump-and-read command can exit137 before webview attachment. its receipt does not identify which subcommand failed. this prevents qualification and leaves its exact remote xml path unconfirmed. the cause is unknown; a later file or successful run does not explain or qualify the failed command.

evidence: source8e0991b4, run20261104-120054-81c36805553a, pre_auth_dump_and_read returned137 after1433ms of its29972ms budget, with host signalnull and killedfalse. no auth or selected journey began. the recorded emulator/private endpoint closed. separate exact recovery later observed the xml present, removed only that path and confirmed absence; all recorded runtime resources and four generated host inputs are now cleared. earlier occurrences have the same unresolved termination boundary.

reproduce through the canonical native readiness step after booting the owned emulator and starting the cleared app. retain actual command status, native hierarchy, timing and exact cleanup. do not accept137, infer out-of-memory, extend the deadline or bypass readiness.

resolve by identifying the termination cause and qualifying its repair with ordinary successful dump/read readiness and complete owned cleanup. recovery alone does not resolve the unexplained exit.
