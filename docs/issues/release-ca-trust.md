# release certificate-trust updates

problem: the deployed api/worker release still uses certifi `2026.1.4`; its api client accepted the incident's direct g3 diagnostic. host ca updates do not change container trust.

source now pins certifi `2026.10.19` and uv `0.13.4`, and requires patched debian ca-certificates in both build and runtime layers. release these changes through the canonical controller using freshly built immutable images. do not patch running containers in place.

resolved when: the next approved release serves the expected source identity and its actual python clients reject both compromised-chain diagnostic hosts while normal https succeeds. node/bun and any separately bundled native-agent trust paths require their own runtime fixes and qualification.
