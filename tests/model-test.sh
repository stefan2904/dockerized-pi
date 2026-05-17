#!/bin/bash

# Load models from settings.json
SETTINGS_PATH="$HOME/.pi/agent/settings.json"
MODELS=$(node -e "const s = require('$SETTINGS_PATH'); console.log(s.enabledModels.join(' '))")

RESULTS=""

for model in $MODELS; do
    echo -n "Testing $model... " >&2
    # Capture output directly. timeout returns 124 on timeout.
    # We capture stderr as well because Codex errors might be printed there.
    # The timeout itself might abort the process, we must preserve error strings from Codex
    
    # Run pi, capture output. Wait up to 10s. If we see Codex error we want to fail cleanly.
    RAW_RESPONSE=$(timeout 10s pi --model "$model" -p "reply only with your model name and version." 2>&1)
    EXIT_CODE=$?
    
    # Check if there's an error output from Codex
    if [[ "$RAW_RESPONSE" == *"Codex error"* ]] || [[ "$RAW_RESPONSE" == *"usage_limit_reached"* ]]; then
        ERROR_MSG=$(echo "$RAW_RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4 | head -n1)
        [ -z "$ERROR_MSG" ] && ERROR_MSG="Codex usage limit reached"
        echo "❌ Fail ($ERROR_MSG)" >&2
        RESULTS+=$'\n'"| $model | ❌ Fail | $ERROR_MSG |"
    elif [ $EXIT_CODE -eq 124 ]; then
        # Did it actually output anything useful before timing out?
        if [[ "$RAW_RESPONSE" == *"]9;4;0"* ]] || [[ -n "$(echo "$RAW_RESPONSE" | grep -o '\]133;D;0.*')" ]]; then
            # It timed out but we got some response, it's just Pi hanging
            echo "✅ OK (Pi hung but responded)" >&2
            CLEAN_RESPONSE=$(echo "$RAW_RESPONSE" | sed 's/\x1B\[[0-9;]*[a-zA-Z]//g' | tr -d '\000-\011\013\014\016-\037' | tr '\n' ' ' | sed 's/|/\\|/g' | sed 's/  */ /g' | xargs | cut -c 1-150)
            RESULTS+=$'\n'"| $model | ✅ OK* | $CLEAN_RESPONSE |"
        else
            echo "❌ Fail (Timeout)" >&2
            RESULTS+=$'\n'"| $model | ❌ Fail | Timeout (10s) |"
        fi
    elif [ -z "$RAW_RESPONSE" ] || [[ "$RAW_RESPONSE" == *"Command aborted"* ]]; then
        echo "❌ Fail (Empty/Aborted, Code $EXIT_CODE)" >&2
        RESULTS+=$'\n'"| $model | ❌ Fail | Empty/Aborted (Code $EXIT_CODE) |"
    else
        echo "✅ OK" >&2
        CLEAN_RESPONSE=$(echo "$RAW_RESPONSE" | sed 's/\x1B\[[0-9;]*[a-zA-Z]//g' | tr -d '\000-\011\013\014\016-\037' | tr '\n' ' ' | sed 's/|/\\|/g' | sed 's/  */ /g' | xargs | cut -c 1-150)
        RESULTS+=$'\n'"| $model | ✅ OK | $CLEAN_RESPONSE |"
    fi
done

echo "# Model Connectivity Test"
echo ""
echo "| Model | Status | Response |"
echo "| :--- | :--- | :--- |"
echo "$RESULTS" | sed '/^$/d'
