# Agent Notes

## GitHub CLI

- Check login with `gh auth status`.
- Configure repository authentication with `gh auth setup-git`.
- Create and push a repository from the current directory with `gh repo create <owner>/<repo> --source=. --remote=origin --push`.

## Pi Todos

- Prefer the `todo` tool when available: `create`, `list`, `get`, `update`, `append`, `claim`, `release`, `delete`.
- Otherwise, create `.pi/todos/<8-hex-id>.md` with JSON front matter (`id`, `title`, `tags`, `status`, `created_at`) followed by Markdown details.
