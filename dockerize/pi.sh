#!/bin/bash


# TOOLS="=--tools read,bash,edit,write" # default
TOOLS="--tools read,bash,edit,write,grep,find,ls"


# location of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

touch "$SCRIPT_DIR/.env" # if user did not create it based on .env.template

# --install flag
if [[ "$1" == "--install" ]]; then
    ZSHRC="$HOME/.zshrc.local"
    if [ ! -f "$ZSHRC" ]; then
        echo "Error: zsh config not found at $ZSHRC"
        exit 1
    fi

    if grep -q "alias pi=" "$ZSHRC" || grep -q "alias pi =" "$ZSHRC"; then
        echo "Alias 'pi' already exists in $ZSHRC"
    else
        echo "Installing 'pi' alias in $ZSHRC..."
        printf "\nalias pi='%s/pi.sh' # pi-coding-agent alias\n" "$SCRIPT_DIR" >> "$ZSHRC"
    fi

    if grep -q "alias pic=" "$ZSHRC" || grep -q "alias pic =" "$ZSHRC"; then
        echo "Alias 'pic' already exists in $ZSHRC"
    else
        echo "Installing 'pic' alias in $ZSHRC..."
        printf "alias pic='%s/pi.sh --continue' # pi-coding-agent alias\n" "$SCRIPT_DIR" >> "$ZSHRC"
    fi
    echo "Successfully installed aliases. Please run 'source ~/.zshrc' or restart your terminal."
    exit 0
fi

# --update flag
if [[ "$1" == "--update" ]]; then
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
if [[ "$1" == "--sessions" ]]; then
    SESSIONS_DIR="$SCRIPT_DIR/pi/agent/sessions"
    if [ ! -d "$SESSIONS_DIR" ]; then
        echo "No sessions found at $SESSIONS_DIR"
        exit 0
    fi
    find "$SESSIONS_DIR" -maxdepth 1 -mindepth 1 -type d | sort | while read -r dir; do
        count=$(find "$dir" -maxdepth 1 -mindepth 1 | wc -l)
        echo "$(basename "$dir"): $count sessions"
    done
    exit 0
fi


DEBUGFLAGS=""
#DEBUGFLAGS="--entrypoint zsh"
# test volumes: ./pi.sh -c 'touch ~/.pi/test'


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
echo "_____________________________________________"

docker run --rm -it \
  -v "$PROJECT_ROOT":/workspace:rw \
  -v "$SCRIPT_DIR/pi":/home/pi/.pi:rw \
  -w "/workspace/$REL_PATH" \
  --env-file "$SCRIPT_DIR/.env" $DEBUGFLAGS \
  pi-coding-agent $TOOLS $SESSION_DIR_CMD "${@}"
