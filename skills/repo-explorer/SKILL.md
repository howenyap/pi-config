---
name: repo-explorer
description: Explore, inspect, investigate, compare, or answer questions about Git repositories that may not already be in the current workspace. Use when Codex needs to clone or reuse an external repository without cluttering the active workspace, especially for repo research, codebase comparison, or reading project metadata outside the current checkout.
---

# Repo Explorer

Use this skill to explore repositories without cluttering the active workspace.

## Repository Cache

Use `~/.explore/repos` as the local cache directory for repositories being explored.

## Current Cache Contents

```!
mkdir -p ~/.explore/repos
ls -la ~/.explore/repos
```

## Flow

1. List the current repository cache contents before deciding what to use.
   - In hosts that support skill shell injection, use the rendered `Current Cache Contents` section above.
   - Otherwise, run `ls -la ~/.explore/repos` before deciding what to use.

2. Check whether the target repository is already present in `~/.explore/repos`.
   - Prefer a stable directory name based on the repository owner and name, such as `owner__repo`.
   - If the repository is already present, use that local checkout for exploration.

3. If the repository is not present, clone it into `~/.explore/repos`, then explore it there.
   - Create `~/.explore/repos` first if it does not exist.
   - Clone with a clear destination path, for example:

```bash
mkdir -p ~/.explore/repos
git clone <repo-url> ~/.explore/repos/<owner>__<repo>
```

After opening the repository, inspect its local instructions and project metadata before making assumptions. Prefer `rg`, `rg --files`, and targeted file reads for exploration.
