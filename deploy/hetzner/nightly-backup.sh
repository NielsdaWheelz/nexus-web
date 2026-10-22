#!/bin/sh
# Take the nightly database backup, then prune expired archives.
# Installed as /usr/local/sbin/nexus-nightly-backup by release.py and run by
# nexus-nightly-backup.service. Writers stay up: pg_dump reads one consistent
# snapshot. A release holds the lock for its whole run, so this backup never
# meets stopped writers or a migration.
set -eu
lock=/run/lock/nexus-backup.lock
exec 9>"$lock"
if ! flock --nonblock 9; then
    echo "a release holds $lock; skipping this backup"
    exit 0
fi

container() {
    docker ps --all --quiet \
        --filter label=com.docker.compose.project=nexus \
        --filter "label=com.docker.compose.service=$1" \
        --filter label=com.docker.compose.oneoff=False
}
# The host records only the released sha; the running containers carry its digests.
sha=$(cat /var/lib/nexus/releases/current)
api_image=$(docker inspect --format '{{.Config.Image}}' "$(container api)")
worker_image=$(docker inspect --format '{{.Config.Image}}' "$(container worker-background)")
revision=$(docker image inspect \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$api_image")
if [ "$revision" != "$sha" ]; then
    echo "the api runs $revision, not the released $sha; finish that release first" >&2
    exit 1
fi

API_IMAGE=$api_image WORKER_IMAGE=$worker_image \
    NEXUS_CONFIG_FILE=/etc/nexus/current.env \
    NEXUS_BACKUP_CONFIG_FILE=/etc/nexus/backup.env \
    NEXUS_BACKUP_STATE_DIRECTORY=/var/backups/nexus/r2 \
    docker compose --project-name nexus --env-file /etc/nexus/current.env \
    --file /etc/nexus/docker-compose.yml --profile backup \
    run --rm --no-deps --no-TTY backup \
    python -m nexus.release_backup nightly --source-sha "$sha" --receipt-root /backup-state
