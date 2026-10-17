# local storage rejects custom web ports

status: open. origin: resource references, 2026-10-16. area: local development.

`docker/docker-compose.yml:29` fixes minio's allowed origins to ports 3000 and
3001. `make web` supports a different `WEB_PORT`; at localhost:3376 a signed pdf
download returned 200 without `access-control-allow-origin`, and the reader could
not open it. a disposable compose override allowing that origin proved the cause.

derive local storage origins from the configured web port, retaining the android
emulator origin. verify signed browser uploads and pdf reads on both the default
and a custom port through the normal local workflow. do not widen production cors.
