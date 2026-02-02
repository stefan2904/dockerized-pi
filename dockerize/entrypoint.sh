#!/bin/sh
set -e

# Configure git if environment variables are set
if [ -n "$BOT_GIT_NAME" ]; then
    git config --global user.name "$BOT_GIT_NAME"
fi

if [ -n "$BOT_GIT_EMAIL" ]; then
    git config --global user.email "$BOT_GIT_EMAIL"
fi

# Configure gh CLI if token is provided
if [ -n "$BOT_GH_TOKEN" ]; then
    echo "$BOT_GH_TOKEN" | gh auth login --with-token
fi

# Execute pi with all passed arguments
exec pi "$@"
