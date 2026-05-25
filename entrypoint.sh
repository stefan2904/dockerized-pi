#!/bin/sh
set -e

SHOW_SUDO_PASSWORD=1
for arg in "$@"; do
    case "$arg" in
        --help|--version)
            SHOW_SUDO_PASSWORD=0
            break
            ;;
    esac
done

# Configure sudo password for the pi user
if [ -n "$PI_SUDO_PASSWORD" ]; then
    echo "pi:$PI_SUDO_PASSWORD" | chpasswd
else
    PI_SUDO_PASSWORD=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 16)
    echo "pi:$PI_SUDO_PASSWORD" | chpasswd
    if [ "$SHOW_SUDO_PASSWORD" -eq 1 ]; then
        echo "=========================================="
        echo " sudo password for pi: $PI_SUDO_PASSWORD"
        echo "=========================================="
    fi
fi
unset PI_SUDO_PASSWORD

# Configure git if environment variables are set
if [ -n "$BOT_GIT_NAME" ]; then
    gosu pi git config --global user.name "$BOT_GIT_NAME"
fi

if [ -n "$BOT_GIT_EMAIL" ]; then
    gosu pi git config --global user.email "$BOT_GIT_EMAIL"
fi

# Configure gh CLI if token is provided
if [ -n "$BOT_GH_TOKEN" ]; then
    echo "$BOT_GH_TOKEN" | gosu pi gh auth login --with-token
fi

# Configure Sentry CLI if token is provided
if [ -n "$BOT_SENTRY_TOKEN" ]; then
    printf "[auth]\ntoken=%s\n" "$BOT_SENTRY_TOKEN" > /home/pi/.sentryclirc
    chown pi /home/pi/.sentryclirc
fi

# Drop privileges and execute pi with all passed arguments
exec gosu pi pi "$@"
