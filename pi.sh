#!/bin/bash


TOOLS="" # enable default tools (and extension tools?)
# TOOLS="=--tools read,bash,edit,write" # default
#TOOLS="--tools read,bash,edit,write,grep,find,ls" # enable all build-in tools (but don't enable extension tools?)


# location of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ORIGINAL_CWD="$PWD"


touch "$SCRIPT_DIR/.env" # if user did not create it based on .env.template
source "$SCRIPT_DIR/.env"


# Handle flags
MOUNT_MODE="rw"
ENTRYPOINT_FILE="$SCRIPT_DIR/entrypoint.sh"
DO_INSTALL=false
DO_UPDATE=false
DO_SESSIONS=false
DO_COMMIT=false
DOCKER_PORT_ARGS=()
DOCKER_NETWORK_ARGS=()
DOCKER_ENV_ARGS=()
DOCKER_ENV_FILE_ARGS=()
DOCKER_VOLUME_ARGS=()
NEW_ARGS=()
CMUX_BRIDGE_PID=""
CMUX_BRIDGE_TMPDIR=""

cleanup_cmux_bridge() {
    if [ -n "$CMUX_BRIDGE_PID" ]; then
        kill "$CMUX_BRIDGE_PID" >/dev/null 2>&1 || true
        wait "$CMUX_BRIDGE_PID" >/dev/null 2>&1 || true
    fi
    if [ -n "$CMUX_BRIDGE_TMPDIR" ]; then
        rm -rf "$CMUX_BRIDGE_TMPDIR" >/dev/null 2>&1 || true
    fi
}

trap cleanup_cmux_bridge EXIT

resolve_env_file() {
    local requested="$1"

    if [[ "$requested" == /* ]]; then
        printf '%s\n' "$requested"
    else
        printf '%s/%s\n' "$ORIGINAL_CWD" "$requested"
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ro|--readonly)
            MOUNT_MODE="ro"
            TOOLS="--tools read,grep,find,ls"
            shift
            ;;
        --install)
            DO_INSTALL=true
            shift
            ;;
        --update)
            DO_UPDATE=true
            shift
            ;;
        --sessions)
            DO_SESSIONS=true
            shift
            ;;
        --commit)
            DO_COMMIT=true
            shift
            ;;
        --entrypoint)
            if [ -z "$2" ]; then
                >&2 echo "Error: --entrypoint requires a path"
                exit 1
            fi
            ENTRYPOINT_FILE="$2"
            shift 2
            ;;
        --entrypoint=*)
            ENTRYPOINT_FILE="${1#--entrypoint=}"
            shift
            ;;
        --port|--publish)
            # Docker port mapping format is HOST_PORT:CONTAINER_PORT.
            # Example: 8080:3000 exposes container port 3000 on host port 8080.
            if [ -z "$2" ]; then
                >&2 echo "Error: $1 requires a port mapping (for example: 8080:8080)"
                exit 1
            fi
            DOCKER_PORT_ARGS+=(-p "$2")
            shift 2
            ;;
        --port=*|--publish=*)
            DOCKER_PORT_ARGS+=(-p "${1#*=}")
            shift
            ;;
        --network|--docker-network)
            # Docker network name or mode. The network must already exist unless
            # using a built-in mode such as host, bridge, or none.
            if [ -z "$2" ]; then
                >&2 echo "Error: $1 requires a Docker network name (for example: my-network)"
                exit 1
            fi
            DOCKER_NETWORK_ARGS+=(--network "$2")
            shift 2
            ;;
        --network=*|--docker-network=*)
            DOCKER_NETWORK_ARGS+=(--network "${1#*=}")
            shift
            ;;
        --env|--docker-env)
            # Docker environment variable in KEY=VALUE form, or KEY to copy
            # from the host environment.
            if [ -z "$2" ]; then
                >&2 echo "Error: $1 requires an environment variable (for example: FOO=bar)"
                exit 1
            fi
            DOCKER_ENV_ARGS+=(-e "$2")
            shift 2
            ;;
        --env=*|--docker-env=*)
            DOCKER_ENV_ARGS+=(-e "${1#*=}")
            shift
            ;;
        --env-file|--docker-env-file)
            # Additional Docker env-file. Relative paths are resolved from the
            # original directory where pi.sh was invoked.
            if [ -z "$2" ]; then
                >&2 echo "Error: $1 requires an env-file path"
                exit 1
            fi
            ENV_FILE_PATH="$(resolve_env_file "$2")"
            if [ ! -f "$ENV_FILE_PATH" ]; then
                >&2 echo "Error: env-file not found: $ENV_FILE_PATH"
                exit 1
            fi
            DOCKER_ENV_FILE_ARGS+=(--env-file "$ENV_FILE_PATH")
            shift 2
            ;;
        --env-file=*|--docker-env-file=*)
            ENV_FILE_PATH="$(resolve_env_file "${1#*=}")"
            if [ ! -f "$ENV_FILE_PATH" ]; then
                >&2 echo "Error: env-file not found: $ENV_FILE_PATH"
                exit 1
            fi
            DOCKER_ENV_FILE_ARGS+=(--env-file "$ENV_FILE_PATH")
            shift
            ;;
        --volume|--docker-volume)
            # Additional Docker volume mount in HOST_PATH:CONTAINER_PATH[:MODE] form.
            # Example: --volume "$VOLUME_SHAREPOINT":/workspace/sharepoint:ro
            if [ -z "$2" ]; then
                >&2 echo "Error: $1 requires a volume mapping (for example: /host/path:/container/path:ro)"
                exit 1
            fi
            DOCKER_VOLUME_ARGS+=(-v "$2")
            shift 2
            ;;
        --volume=*|--docker-volume=*)
            DOCKER_VOLUME_ARGS+=(-v "${1#*=}")
            shift
            ;;
        *)
            NEW_ARGS+=("$1")
            shift
            ;;
    esac
done
set -- "${NEW_ARGS[@]}"

# Resolve entrypoint path. Plain relative paths are relative to this script.
# Absolute paths are used as-is. Bare names can be used as shortcuts for
# bundled entrypoints, e.g. "zsh" resolves to "entrypoint-zsh.sh" when that
# file exists.
resolve_entrypoint_file() {
    local requested="$1"
    local base=""
    local candidates=()

    if [[ "$requested" == /* ]]; then
        printf '%s\n' "$requested"
        return
    fi

    if [[ "$requested" == */* ]]; then
        printf '%s/%s\n' "$SCRIPT_DIR" "$requested"
        return
    fi

    base="$SCRIPT_DIR/$requested"
    candidates+=("$base")
    if [[ "$requested" != *.sh ]]; then
        candidates+=("$base.sh")
    fi
    if [[ "$requested" != entrypoint-* ]]; then
        candidates+=("$SCRIPT_DIR/entrypoint-$requested")
        if [[ "$requested" != *.sh ]]; then
            candidates+=("$SCRIPT_DIR/entrypoint-$requested.sh")
        fi
    fi

    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done

    printf '%s\n' "$base"
}

ENTRYPOINT_FILE="$(resolve_entrypoint_file "$ENTRYPOINT_FILE")"
if [ ! -f "$ENTRYPOINT_FILE" ]; then
    >&2 echo "Error: entrypoint file not found: $ENTRYPOINT_FILE"
    exit 1
fi

# --commit flag
if [ "$DO_COMMIT" = true ]; then
    MODEL_ARG=""
    if [ -n "$PI_FAST_MODEL" ]; then
        MODEL_ARG="--provider $PI_FAST_PROVIDER --model $PI_FAST_MODEL"
    fi
    set -- $MODEL_ARG "/commit --force --user \"$(git config user.name)\" --email \"$(git config user.email)\""
fi

# --install flag
if [ "$DO_INSTALL" = true ]; then
    SHELL_CONFIG=""
    for f in "$HOME/.zshrc.local" "$HOME/.zshrc" "$HOME/.bashrc"; do
        if [ -f "$f" ]; then
            SHELL_CONFIG="$f"
            break
        fi
    done

    if [ -z "$SHELL_CONFIG" ]; then
        >&2 echo "Error: Could not find ~/.zshrc.local, ~/.zshrc, or ~/.bashrc"
        exit 1
    fi

    if ! grep -q "# pi-coding-agent alias" "$SHELL_CONFIG"; then
        printf "\n" >> "$SHELL_CONFIG"
    fi

    for alias_name in "pi" "pic" "picommit"; do
        if grep -q "^alias $alias_name=" "$SHELL_CONFIG" || grep -q "^alias $alias_name =" "$SHELL_CONFIG"; then
            >&2 echo "Updating '$alias_name' alias in $SHELL_CONFIG..."
            grep -v "^alias $alias_name=" "$SHELL_CONFIG" | grep -v "^alias $alias_name =" > "$SHELL_CONFIG.tmp" && mv "$SHELL_CONFIG.tmp" "$SHELL_CONFIG"
        else
            echo "Installing '$alias_name' alias in $SHELL_CONFIG..."
        fi

        case "$alias_name" in
            pi)
                printf "alias pi='%s/pi.sh' # pi-coding-agent alias\n" "$SCRIPT_DIR" >> "$SHELL_CONFIG"
                ;;
            pic)
                printf "alias pic='%s/pi.sh --continue' # pi-coding-agent alias\n" "$SCRIPT_DIR" >> "$SHELL_CONFIG"
                ;;
            picommit)
                printf "alias picommit='%s/pi.sh --commit' # pi-coding-agent alias\n" "$SCRIPT_DIR" >> "$SHELL_CONFIG"
                ;;
        esac
    done
    >&2 echo "Successfully installed/updated aliases. Please run 'source $SHELL_CONFIG' or restart your terminal."
    exit 0
fi

# --update flag
if [ "$DO_UPDATE" = true ]; then
    cd "$SCRIPT_DIR"
    CURRENT_VERSION=$(./build.sh --installed-version)
    LATEST_VERSION=$(curl -s https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest | jq -r .version)

    >&2 echo "Latest pi version:            $LATEST_VERSION"
    >&2 echo "Current installed pi version: $CURRENT_VERSION"

    if [ "$CURRENT_VERSION" == "$LATEST_VERSION" ]; then
        >&2 echo "Pi image already up to date."
        UPDATED_VERSION="$CURRENT_VERSION"
    else
        >&2 echo "Updating pi to version $LATEST_VERSION ..."
        ./build.sh "$LATEST_VERSION"

        UPDATED_VERSION=$(./build.sh --installed-version)
        >&2 echo "Updated to pi version: $UPDATED_VERSION"

        if [ "$UPDATED_VERSION" != "$LATEST_VERSION" ]; then
            >&2 echo "Warning: expected version $LATEST_VERSION but got $UPDATED_VERSION"
        fi
    fi

    >&2 echo "Updating configured extensions ..."
    ./pi.sh update --extensions
    exit 0
fi

# --sessions flag
if [ "$DO_SESSIONS" = true ]; then
    SESSIONS_DIR="$SCRIPT_DIR/pi/agent/sessions"
    if [ ! -d "$SESSIONS_DIR" ]; then
        >&2 echo "No sessions found at $SESSIONS_DIR"
        exit 0
    fi
    BOLD='\033[1m'
    CYAN='\033[0;36m'
    GREEN='\033[0;32m'
    NC='\033[0m' # No Color

    echo -e "${BOLD}Sessions directory:${NC} ${CYAN}$SESSIONS_DIR${NC}"
    find "$SESSIONS_DIR" -maxdepth 1 -mindepth 1 -type d | sort | while read -r dir; do
        basename_dir=$(basename "$dir")
        if [ "$basename_dir" == "logs" ]; then
            continue
        fi
        count=$(find "$dir" -maxdepth 1 -mindepth 1 -type f -name "*.jsonl" | wc -l)
        >&2 echo -e "${BOLD}${GREEN}$basename_dir${NC}: $count sessions"
        find "$dir" -maxdepth 1 -mindepth 1 -type f -name "*.jsonl" -exec basename {} \; | sort -r | head -n 5 | while read -r session; do
            >&2 echo "  - $session"
        done
    done
    exit 0
fi

# map cache dirs used by my pi
mkdir -p "$SCRIPT_DIR/.cache/checkouts"
mkdir -p "$SCRIPT_DIR/.cache/gondolin/images"


DEBUGFLAGS=""
#DEBUGFLAGS="--entrypoint zsh"
# test volumes: ./pi.sh -c 'touch ~/.pi/test'
EXTRA_VOLUMES=()
EXTRA_PI_ARGS=()


if [ -f ".pi_ro" ]; then
    MOUNT_MODE="ro"
    >&2 echo "WARNING: .pi_ro found in current directory. Forcing READ-ONLY mount."
fi

>&2 echo "INFO: Using env file: $SCRIPT_DIR/.env"
if [ -n "$DEBUGFLAGS" ]; then
    >&2 echo "INFO: docker run flags: $DEBUGFLAGS"
fi

# Optional per-directory read-only volume mounts.
# .volumes.yml is expected to contain entries like:
# - "~/some/project": "~/some/notes"
VOLUMES_FILE="$SCRIPT_DIR/.volumes.yml"
if [ -f "$VOLUMES_FILE" ]; then
    PROJECT_ORG_NOTES=$(python3 - "$VOLUMES_FILE" "$ORIGINAL_CWD" <<'PY'
import ast
import os
import sys

volumes_file, cwd = sys.argv[1], sys.argv[2]


def canonicalize(path):
    return os.path.abspath(os.path.expanduser(path))


volumes = {}
with open(volumes_file, encoding="utf-8") as f:
    for lineno, line in enumerate(f, 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not line.startswith("- "):
            raise SystemExit(f"{volumes_file}:{lineno}: expected '- key: value'")
        try:
            item = ast.literal_eval("{" + line[2:] + "}")
        except Exception as e:
            raise SystemExit(f"{volumes_file}:{lineno}: could not parse entry: {e}")
        if not isinstance(item, dict) or len(item) != 1:
            raise SystemExit(f"{volumes_file}:{lineno}: expected exactly one key/value pair")
        volumes.update(item)

cwd = canonicalize(cwd)
for host_cwd, notes_dir in volumes.items():
    if canonicalize(str(host_cwd)) == cwd:
        print(canonicalize(str(notes_dir)))
        break
PY
)
    if [ -n "$PROJECT_ORG_NOTES" ]; then
        EXTRA_VOLUMES+=(-v "$PROJECT_ORG_NOTES:/workspace-notes:ro")
        EXTRA_PI_ARGS+=(--append-system-prompt "Additional read-only project notes are mounted at /workspace-notes. Use them when relevant, but do not edit them.")
        >&2 echo "INFO: Mounting project notes read-only: $PROJECT_ORG_NOTES -> /workspace-notes"
    fi
fi

# Find the project root by looking for .git, .project, or .projectile
# upward from PWD, stopping at $HOME or /
PROJECT_ROOT=""
curr="$PWD"
while true; do
    if [ -d "$curr/.git" ] || [ -f "$curr/.project" ] || [ -f "$curr/.projectile" ]; then
        PROJECT_ROOT="$curr"
        break
    fi
    [ "$curr" = "/" ] || [ "$curr" = "$HOME" ] && break
    curr=$(dirname "$curr")
done

if [ -z "$PROJECT_ROOT" ]; then
    PROJECT_ROOT="$PWD"
fi

# Canonicalize PROJECT_ROOT for session directory naming to avoid everything being in --workspace--
# Matches logic in session-manager.js: cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
CWD_SAFE=$(echo "$PROJECT_ROOT" | sed 's|^[/\\]||' | sed 's|[/\\:]|-|g')
SESSION_DIR="/home/pi/.pi/agent/sessions/--${CWD_SAFE}--"
SESSION_DIR_CMD=(--session-dir "$SESSION_DIR")

# If first arg is a command, don't use TOOLS or SESSION_DIR_CMD
case "$1" in
    install|remove|update|list|config)
        TOOLS=""
        SESSION_DIR_CMD=()
        EXTRA_PI_ARGS=()
        ;;
esac

# Calculate relative path from PROJECT_ROOT to PWD
REL_PATH=${PWD:${#PROJECT_ROOT}}
REL_PATH=${REL_PATH#/}

setup_cmux_bridge() {
    [ -n "${CMUX_SURFACE_ID:-}" ] || return 0
    command -v cmux >/dev/null 2>&1 || return 0
    [ -x "$SCRIPT_DIR/cmux-bridge/host.py" ] || return 0
    [ -x "$SCRIPT_DIR/cmux-bridge/cmux" ] || return 0

    local bridge_python=""
    if command -v python3 >/dev/null 2>&1; then
        bridge_python="$(command -v python3)"
    elif command -v python >/dev/null 2>&1; then
        bridge_python="$(command -v python)"
    else
        >&2 echo "WARNING: cmux detected, but python3/python is unavailable; Pi cmux hooks disabled."
        return 0
    fi

    PI_CODING_AGENT_DIR="$SCRIPT_DIR/pi/agent" cmux hooks pi install --yes >/dev/null 2>&1 || true

    CMUX_BRIDGE_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-cmux-bridge.XXXXXX")"
    local ready_file="$CMUX_BRIDGE_TMPDIR/ready.json"
    local bridge_uv_cache="$CMUX_BRIDGE_TMPDIR/uv-cache"
    local token
    token="$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    local cmux_bin
    cmux_bin="$(command -v cmux)"

    UV_CACHE_DIR="${UV_CACHE_DIR:-$bridge_uv_cache}" "$bridge_python" "$SCRIPT_DIR/cmux-bridge/host.py" \
        --token "$token" \
        --cmux-bin "$cmux_bin" \
        --ready-file "$ready_file" &
    CMUX_BRIDGE_PID=$!

    local i
    for i in $(seq 1 50); do
        [ -s "$ready_file" ] && break
        if ! kill -0 "$CMUX_BRIDGE_PID" >/dev/null 2>&1; then
            >&2 echo "WARNING: cmux bridge exited before becoming ready; Pi cmux hooks disabled."
            cleanup_cmux_bridge
            CMUX_BRIDGE_PID=""
            CMUX_BRIDGE_TMPDIR=""
            return 0
        fi
        sleep 0.1
    done
    if [ ! -s "$ready_file" ]; then
        >&2 echo "WARNING: cmux bridge did not become ready; Pi cmux hooks disabled."
        cleanup_cmux_bridge
        CMUX_BRIDGE_PID=""
        CMUX_BRIDGE_TMPDIR=""
        return 0
    fi

    local port
    port="$(UV_CACHE_DIR="${UV_CACHE_DIR:-$bridge_uv_cache}" "$bridge_python" - "$ready_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f)["port"])
PY
)"

    local launch_argv_b64
    launch_argv_b64="$(UV_CACHE_DIR="${UV_CACHE_DIR:-$bridge_uv_cache}" "$bridge_python" - "$SCRIPT_DIR/pi.sh" "$@" <<'PY'
import base64, sys
payload = b"".join(arg.encode("utf-8") + b"\0" for arg in sys.argv[1:])
print(base64.b64encode(payload).decode("ascii"), end="")
PY
)"

    DOCKER_VOLUME_ARGS+=(-v "$SCRIPT_DIR/cmux-bridge/cmux:/usr/local/bin/cmux:ro")
    DOCKER_ENV_ARGS+=(-e "CMUX_BRIDGE_URL=http://host.docker.internal:$port")
    DOCKER_ENV_ARGS+=(-e "CMUX_BRIDGE_TOKEN=$token")
    DOCKER_ENV_ARGS+=(-e "CMUX_PI_CMUX_BIN=/usr/local/bin/cmux")
    DOCKER_ENV_ARGS+=(-e "CMUX_PI_HOST_LAUNCHER=$SCRIPT_DIR/pi.sh")
    DOCKER_ENV_ARGS+=(-e "CMUX_PI_HOST_PROJECT_ROOT=$PROJECT_ROOT")
    DOCKER_ENV_ARGS+=(-e "CMUX_PI_CONTAINER_PROJECT_ROOT=/workspace")
    DOCKER_ENV_ARGS+=(-e "CMUX_WORKSPACE_ID=${CMUX_WORKSPACE_ID:-}")
    DOCKER_ENV_ARGS+=(-e "CMUX_SURFACE_ID=${CMUX_SURFACE_ID:-}")
    DOCKER_ENV_ARGS+=(-e "CMUX_PANEL_ID=${CMUX_PANEL_ID:-${CMUX_SURFACE_ID:-}}")
    DOCKER_ENV_ARGS+=(-e "CMUX_TAB_ID=${CMUX_TAB_ID:-${CMUX_WORKSPACE_ID:-}}")
    DOCKER_ENV_ARGS+=(-e "CMUX_AGENT_LAUNCH_KIND=pi")
    DOCKER_ENV_ARGS+=(-e "CMUX_AGENT_LAUNCH_EXECUTABLE=$SCRIPT_DIR/pi.sh")
    DOCKER_ENV_ARGS+=(-e "CMUX_AGENT_LAUNCH_ARGV_B64=$launch_argv_b64")
    DOCKER_ENV_ARGS+=(-e "CMUX_AGENT_LAUNCH_CWD=$PWD")
    >&2 echo "INFO: Enabled cmux bridge for Dockerized Pi hooks."
}

setup_cmux_bridge "$@"

>&2 echo "INFO: Using project root: $PROJECT_ROOT"
if [ -n "$REL_PATH" ]; then
    >&2 echo "INFO: Using relative path: $REL_PATH"
fi
if [ "$MOUNT_MODE" = "ro" ]; then
    >&2 echo "INFO: Mounting /workspace as READ-ONLY"
fi
if [ ${#DOCKER_PORT_ARGS[@]} -gt 0 ]; then
    >&2 echo "INFO: Publishing Docker ports: ${DOCKER_PORT_ARGS[*]}"
fi
if [ ${#DOCKER_NETWORK_ARGS[@]} -gt 0 ]; then
    >&2 echo "INFO: Using Docker network: ${DOCKER_NETWORK_ARGS[*]}"
fi
if [ ${#DOCKER_VOLUME_ARGS[@]} -gt 0 ]; then
    >&2 echo "INFO: Mounting additional Docker volumes: ${DOCKER_VOLUME_ARGS[*]}"
fi
>&2 echo "_____________________________________________"

# Determine if we are in an interactive terminal
INTERACTIVE_FLAGS=""
if [ -t 0 ] && [ -t 1 ]; then
    INTERACTIVE_FLAGS="-it"
else
    >&2 echo "INFO: Runnin in non-interactive mode."
fi

docker run --rm $INTERACTIVE_FLAGS \
  "${DOCKER_PORT_ARGS[@]}" \
  "${DOCKER_NETWORK_ARGS[@]}" \
  "${DOCKER_VOLUME_ARGS[@]}" \
  -v "$PROJECT_ROOT":/workspace:$MOUNT_MODE \
  -v "$SCRIPT_DIR/pi":/home/pi/.pi:rw \
  -v "$SCRIPT_DIR/.cache/checkouts":/home/pi/.cache/checkouts:rw \
  -v "$SCRIPT_DIR/.cache/gondolin":/home/pi/.cache/gondolin:rw \
  -v "$ENTRYPOINT_FILE":/usr/local/bin/entrypoint.sh:ro \
  "${EXTRA_VOLUMES[@]}" \
  -w "/workspace/$REL_PATH" \
  -e PI_PROJECT_ROOT="$PROJECT_ROOT" \
  -e PI_MOUNT_MODE="$MOUNT_MODE" \
  -e PI_HOST_HOSTNAME="$(hostname)" \
  ${BOT_SENTRY_TOKEN:+-e BOT_SENTRY_TOKEN} \
  ${PI_SUDO_PASSWORD:+-e PI_SUDO_PASSWORD} \
  ${ANTHROPIC_API_KEY:+-e ANTHROPIC_API_KEY} \
  ${OPENAI_API_KEY:+-e OPENAI_API_KEY} \
  ${GEMINI_API_KEY:+-e GEMINI_API_KEY} \
  ${MISTRAL_API_KEY:+-e MISTRAL_API_KEY} \
  ${HF_TOKEN:+-e HF_TOKEN} \
  ${OPENROUTER_API_KEY:+-e OPENROUTER_API_KEY} \
  ${PI_CACHE_RETENTION:+-e PI_CACHE_RETENTION} \
  --env-file "$SCRIPT_DIR/.env" \
  "${DOCKER_ENV_FILE_ARGS[@]}" \
  "${DOCKER_ENV_ARGS[@]}" \
  $DEBUGFLAGS \
  pi-coding-agent $TOOLS "${SESSION_DIR_CMD[@]}" "${EXTRA_PI_ARGS[@]}" "${@}"
