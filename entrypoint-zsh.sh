#!/bin/sh
set -e

echo "Running in container ..."
echo "User:  $(whoami)"
echo "CWD:   $(pwd)"
echo "Mount: $PI_PROJECT_ROOT"

if [ -n "$BOT_GH_TOKEN" ]; then
    echo "Logging in GH CLI ..."
    echo "$BOT_GH_TOKEN" | gosu pi gh auth login --with-token

    echo "Setup GIT access for repo ..."
    gosu pi gh auth setup-git
fi

echo "Here is your zsh:"
exec zsh
