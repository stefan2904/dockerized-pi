#!/bin/bash


# TOOLS="=--tools read,bash,edit,write" # default
TOOLS="--tools read,bash,edit,write,grep,find,ls"


# location of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Handle flags
MOUNT_MODE="rw"
DO_INSTALL=false
DO_UPDATE=false
DO_SESSIONS=false
NEW_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ro|--readonly)
            MOUNT_MODE="ro"
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
        *)
            NEW_ARGS+=("$1")
            shift
            ;;
    esac
done
set -- "${NEW_ARGS[@]}"

touch "$SCRIPT_DIR/.env" # if user did not create it based on .env.template

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
        echo "Error: Could not find ~/.zshrc.local, ~/.zshrc, or ~/.bashrc"
        exit 1
    fi

    if ! grep -q "# pi-coding-agent alias" "$SHELL_CONFIG"; then
        printf "\n" >> "$SHELL_CONFIG"
    fi

    for alias_name in "pi" "pic" "picommit"; do
        if grep -q "^alias $alias_name=" "$SHELL_CONFIG" || grep -q "^alias $alias_name =" "$SHELL_CONFIG"; then
            echo "Updating '$alias_name' alias in $SHELL_CONFIG..."
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
                printf "alias picommit=\"%s/pi.sh '/commit --force --user \\\"\$(git config user.name)\\\" --email \\\"\$(git config user.email)\\\"'\" # pi-coding-agent alias\n" "$SCRIPT_DIR" >> "$SHELL_CONFIG"
                ;;
        esac
    done
    echo "Successfully installed/updated aliases. Please run 'source $SHELL_CONFIG' or restart your terminal."
    exit 0
fi

# --update flag
if [ "$DO_UPDATE" = true ]; then
    cd "$SCRIPT_DIR"
    CURRENT_VERSION=$(docker run --rm pi-coding-agent --version)
    LATEST_VERSION=$(curl -s https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest | jq -r .version)
    if [ "$CURRENT_VERSION" == "$LATEST_VERSION" ]; then
        echo "Already up to date. Rebuilding anyway ..."
    else
        echo "Updating pi to version $LATEST_VERSION ..."
    fi
    ./build.sh "$LATEST_VERSION"
    UPDATED_VERSION=$(docker run --rm pi-coding-agent --version)
    echo "Updated to pi version: $UPDATED_VERSION"
    if [ "$CURRENT_VERSION" == "$UPDATED_VERSION" ]; then
        echo " Version did not change!"
    fi
    exit 0
fi

# --sessions flag
if [ "$DO_SESSIONS" = true ]; then
    SESSIONS_DIR="$SCRIPT_DIR/pi/agent/sessions"
    if [ ! -d "$SESSIONS_DIR" ]; then
        echo "No sessions found at $SESSIONS_DIR"
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
        echo -e "${BOLD}${GREEN}$basename_dir${NC}: $count sessions"
        find "$dir" -maxdepth 1 -mindepth 1 -type f -name "*.jsonl" -exec basename {} \; | sort -r | head -n 5 | while read -r session; do
            echo "  - $session"
        done
    done
    exit 0
fi


DEBUGFLAGS=""
#DEBUGFLAGS="--entrypoint zsh"
# test volumes: ./pi.sh -c 'touch ~/.pi/test'


if [ -f ".pi_ro" ]; then
    MOUNT_MODE="ro"
    echo "WARNING: .pi_ro found in current directory. Forcing READ-ONLY mount."
fi

echo "INFO: Using env file: $SCRIPT_DIR/.env"
if [ -n "$DEBUGFLAGS" ]; then
    echo "INFO: docker run flags: $DEBUGFLAGS"
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
SESSION_DIR_CMD="--session-dir $SESSION_DIR"

# If first arg is a command, don't use TOOLS or SESSION_DIR_CMD
case "$1" in
    install|remove|update|list|config)
        TOOLS=""
        SESSION_DIR_CMD=""
        ;;
esac

# Calculate relative path from PROJECT_ROOT to PWD
REL_PATH=${PWD:${#PROJECT_ROOT}}
REL_PATH=${REL_PATH#/}

echo "INFO: Using project root: $PROJECT_ROOT"
if [ -n "$REL_PATH" ]; then
    echo "INFO: Using relative path: $REL_PATH"
fi
if [ "$MOUNT_MODE" = "ro" ]; then
    echo "INFO: Mounting /workspace as READ-ONLY"
fi
echo "_____________________________________________"

# Determine if we are in an interactive terminal
INTERACTIVE_FLAGS="-it"
if [ ! -t 0 ]; then
    INTERACTIVE_FLAGS=""
fi

docker run --rm $INTERACTIVE_FLAGS \
  -v "$PROJECT_ROOT":/workspace:$MOUNT_MODE \
  -v "$SCRIPT_DIR/pi":/home/pi/.pi:rw \
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
  --env-file "$SCRIPT_DIR/.env" $DEBUGFLAGS \
  pi-coding-agent $TOOLS $SESSION_DIR_CMD "${@}"
