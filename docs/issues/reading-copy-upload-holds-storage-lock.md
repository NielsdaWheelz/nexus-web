# a reading-copy upload holds the api's storage lock

**problem.** `POST /media/{id}/reading-copy` uploads the built zip with
`StorageClient.put_object_stream`, which holds the process-wide
`_operation_lock` (#576: botocore's shared tls context) for the whole
`put_object`, body included.

**impact.** While a copy uploads, every other storage call in that api process
waits: signed urls (`/media/{id}/file`, the next reading copy), epub asset and
share pdf reads. A large pdf copy stalls them for the upload's duration, up to
the copy lane's 280 s budget. Before the edge slice the api streamed the zip to
the caller and never uploaded in a request.

**evidence.** `python/nexus/api/routes/reader.py` (`create_reading_copy`),
`python/nexus/storage/client.py` (`put_object_stream`, `_operation_lock`).

**resolved when** an upload in the api holds the lock only per sdk call or
chunk (multipart parts under the lock, or a presigned put outside botocore),
and a probe shows a `sign_download` answered while a 100 MB copy uploads.
