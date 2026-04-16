#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

if [ "${1:-}" = "--installed-version" ]; then
    "$SCRIPT_DIR/pi.sh" --version </dev/null 2>&1 | awk '/^[0-9]+\.[0-9]+\.[0-9]+$/ { v=$0 } END { if (v) print v }'
    exit 0
fi

VERSION=${1:-latest}
BUILDARGS="--build-arg UID=$(id -u) --build-arg GID=$(id -g) --build-arg VERSION=$VERSION"

docker build $BUILDARGS -t pi-coding-agent -f "$SCRIPT_DIR/Dockerfile.release" "$SCRIPT_DIR"
#docker build $BUILDARGS -t pi-coding-agent -f "$SCRIPT_DIR/Dockerfile.git" "$SCRIPT_DIR"
