#!/usr/bin/env bash
# Find an available port, starting from the preferred port
# Usage: find_port.sh <preferred_port> [service_name]
# Outputs the available port to stdout

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test_env.sh"

preferred_port=${1:-5432}
service_name=${2:-service}

test_env_validate_port "$preferred_port" "$service_name port"

if ! test_env_port_is_busy "$preferred_port"; then
    echo "$preferred_port"
    exit 0
fi

# Find next available port
port=$((preferred_port + 1))
max_port=$((preferred_port + 100))

while [ $port -lt $max_port ]; do
    if ! test_env_port_is_busy "$port"; then
        echo "$port"
        echo "Note: $service_name port $preferred_port in use, using $port instead" >&2
        exit 0
    fi
    port=$((port + 1))
done

echo "Error: Could not find available port for $service_name starting from $preferred_port" >&2
exit 1
