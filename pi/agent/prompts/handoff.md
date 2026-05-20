---
description: Generate a concise handoff prompt for a new Pi session
---
Generate a brief handoff prompt that I can paste into a fresh Pi session to continue this work.

First inspect the current context as needed (for example `git status --short`, recent diffs, and relevant files). Then return only the handoff prompt: no preamble, no markdown fence, no extended chronology.

Keep it short, ideally under 250 words, and include only what is needed to resume effectively:
- Current repo/project context and working directory
- Important instructions or docs the next agent should read first
- Current git/worktree state, including uncommitted changes
- What was completed recently
- Validation commands and latest known results
- Key files/modules touched or relevant
- Next recommended tasks, in priority order
- Known blockers, caveats, or things explicitly not to do yet

Write it as a directly usable prompt with exact file paths and commands where helpful.
