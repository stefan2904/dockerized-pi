#!/bin/bash

# Load models from settings.json
SETTINGS_PATH="$HOME/.pi/agent/settings.json"
MODELS=$(node -e "const s = require('$SETTINGS_PATH'); console.log(s.enabledModels.join(' '))")

RESULTS=""

for model in $MODELS; do
    echo -n "Testing $model... " >&2
    # Capture output directly. timeout returns 124 on timeout.
    # We capture stderr as well because Codex errors might be printed there.
    RAW_RESPONSE=$(timeout 20s pi --model "$model" -p "reply only with your model name and version." 2>&1)
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 124 ]; then
        echo "❌ Fail (Timeout)" >&2
        RESULTS+=$'\n'"| $model | ❌ Fail | Timeout (20s) |"
    elif [[ "$RAW_RESPONSE" == *"Codex error"* ]] || [[ "$RAW_RESPONSE" == *"usage_limit_reached"* ]]; then
        # Extract the error message if possible
        ERROR_MSG=$(echo "$RAW_RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4 | head -n1)
        [ -z "$ERROR_MSG" ] && ERROR_MSG="Codex usage limit reached"
        echo "❌ Fail ($ERROR_MSG)" >&2
        RESULTS+=$'\n'"| $model | ❌ Fail | $ERROR_MSG |"
    elif [ -z "$RAW_RESPONSE" ] || [[ "$RAW_RESPONSE" == *"Command aborted"* ]]; then
        echo "❌ Fail (Empty/Aborted, Code $EXIT_CODE)" >&2
        RESULTS+=$'\n'"| $model | ❌ Fail | Empty/Aborted (Code $EXIT_CODE) |"
    else
        echo "✅ OK" >&2
        # Success: now clean up the output for the markdown table
        # 1. Strip ANSI escape codes
        # 2. Strip control characters
        # 3. Flatten newlines
        # 4. Escape pipes for markdown
        CLEAN_RESPONSE=$(echo "$RAW_RESPONSE" | sed 's/\x1B\[[0-9;]*[a-zA-Z]//g' | tr -d '\000-\011\013\014\016-\037' | tr '\n' ' ' | sed 's/|/\\|/g' | sed 's/  */ /g' | xargs | cut -c 1-150)
        RESULTS+=$'\n'"| $model | ✅ OK | $CLEAN_RESPONSE |"
    fi
done

echo "# Model Connectivity Test"
echo ""
echo "| Model | Status | Response |"
echo "| :--- | :--- | :--- |"
echo "$RESULTS" | sed '/^$/d'
