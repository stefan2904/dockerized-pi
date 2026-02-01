#!/bin/bash

# location of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Using env file: $SCRIPT_DIR/.env"

docker run --rm -it \
  -v "$PWD":/workspace \
  -v "$SCRIPT_DIR/pi":/home/pi/.pi \
  -w /workspace \
  --env-file "$SCRIPT_DIR/.env" \
  pi-coding-agent
