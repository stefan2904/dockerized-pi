---
description: Get next open clawpatch report finding, fix it, revalidate, and commit.
---
1. Get the next open clawpatch report finding: `npx clawpatch report --status open` and take the first ID.
2. Fix the finding: `npx clawpatch fix --finding <ID>`. (If blocked by dirty worktree, commit or stash first).
3. Revalidate the fix: `npx clawpatch revalidate --finding <ID>`.
4. Commit the changes:
   - Stage changes (including `.clawpatch` updates).
   - Write a descriptive commit message with the following structure:
     - **Subject**: `fix: <Title of the finding>`
     - **Body**:
       - **Changes**: Technical summary of code modifications and evidence path status.
       - **Regression Test**: Location and purpose of added tests.
       - **Summary**: Brief explanation of how the fix prevents the issue.
     - Use a professional, technical tone with specific file and function names.
