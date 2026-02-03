---
name: git-autopep8
description: Automatically formats changed lines in Python files using git and autopep8. Only applies formatting to lines that have been modified or added. Use this to maintain PEP 8 compliance on your current changes without refactoring entire legacy files.
---

# git-autopep8

This skill identifies changed lines in Python files (staged, unstaged, and untracked) using `git` and applies `autopep8` formatting specifically to those line ranges.

## Requirements

- `git`
- `autopep8` (install via `pip install autopep8` or `uv add autopep8`)

## Usage

Run the script to format all current Python changes in the repository:

```bash
./scripts/format_changes.py
```

It uses `git diff HEAD` to find changes and `autopep8 --line-range` to apply formatting only to the affected lines. Untracked files are formatted entirely.
