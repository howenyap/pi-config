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
cache="$HOME/.explore/repos"
mkdir -p "$cache"

printf 'Available cached repositories in %s\n' "$cache"
printf 'Remote metadata is fetched for status only; no pull, merge, rebase, or checkout is performed.\n\n'

if ! find "$cache" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -q .; then
  printf '(none)\n'
else
  find "$cache" -mindepth 1 -maxdepth 1 -type d | sort | while IFS= read -r repo; do
    name=$(basename "$repo")

    if [ ! -d "$repo/.git" ]; then
      printf '%s\n  not a git repository\n' "$name"
      continue
    fi

    branch=$(git -C "$repo" branch --show-current 2>/dev/null || true)
    [ -n "$branch" ] || branch="detached"
    local_head=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || printf '?')
    last_commit=$(git -C "$repo" log -1 --format='%cr' 2>/dev/null || printf 'unknown')

    remote=$(git -C "$repo" config --get "branch.$branch.remote" 2>/dev/null || true)
    [ -n "$remote" ] || remote=$(git -C "$repo" remote 2>/dev/null | head -n1)

    fetch_status="no remote"
    if [ -n "$remote" ]; then
      if git -C "$repo" fetch --quiet --tags --prune --no-recurse-submodules "$remote" 2>/dev/null; then
        fetch_status="fetched $remote"
      else
        fetch_status="fetch failed for $remote"
      fi
    fi

    upstream=$(git -C "$repo" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
    if [ -z "$upstream" ] && [ "$branch" != "detached" ] && git -C "$repo" show-ref --verify --quiet "refs/remotes/$remote/$branch" 2>/dev/null; then
      upstream="$remote/$branch"
    fi

    remote_head="n/a"
    ahead="?"
    behind="?"
    freshness="unknown"
    if [ -n "$upstream" ]; then
      remote_head=$(git -C "$repo" rev-parse --short "$upstream" 2>/dev/null || printf 'n/a')
      counts=$(git -C "$repo" rev-list --left-right --count "HEAD...$upstream" 2>/dev/null || printf '? ?')
      ahead=$(printf '%s' "$counts" | awk '{print $1}')
      behind=$(printf '%s' "$counts" | awk '{print $2}')
      if [ "$behind" = "0" ] && [ "$ahead" = "0" ]; then
        freshness="current"
      elif [ "$behind" = "0" ]; then
        freshness="ahead $ahead commit(s)"
      elif [ "$ahead" = "0" ]; then
        freshness="behind $behind commit(s)"
      else
        freshness="diverged: ahead $ahead, behind $behind"
      fi
    fi

    current_semver=$(git -C "$repo" describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --match '[0-9]*.[0-9]*.[0-9]*' HEAD 2>/dev/null || true)
    latest_semver=$(git -C "$repo" for-each-ref --sort=-v:refname --format='%(refname:short)' refs/tags 2>/dev/null | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+([.-]|$)' | head -n1)
    semver_status=$(awk -v cur="$current_semver" -v latest="$latest_semver" '
      function norm(s) { sub(/^v/, "", s); sub(/[-+].*$/, "", s); return s }
      BEGIN {
        if (cur == "" || latest == "") { print "semver n/a"; exit }
        c = norm(cur); l = norm(latest)
        split(c, ca, "."); split(l, la, ".")
        if (c == l) print "semver current"
        else if (ca[1] != la[1]) print "semver major gap"
        else if (ca[2] != la[2]) print "semver minor gap"
        else if (ca[3] != la[3]) print "semver patch gap"
        else print "semver prerelease/build gap"
      }')
    [ -n "$current_semver" ] || current_semver="n/a"
    [ -n "$latest_semver" ] || latest_semver="n/a"

    printf '%s\n' "$name"
    printf '  branch: %s  status: %s  fetch: %s\n' "$branch" "$freshness" "$fetch_status"
    printf '  heads: local %s  upstream %s (%s)\n' "$local_head" "$remote_head" "${upstream:-none}"
    printf '  tags: current %s  latest %s  %s\n' "$current_semver" "$latest_semver" "$semver_status"
    printf '  local HEAD commit age: %s\n' "$last_commit"
  done
fi
```

## Flow

1. Review the current repository cache status before deciding what to use.
   - In hosts that support skill shell injection, use the rendered `Current Cache Contents` section above.
   - Otherwise, run comparable shell commands in `~/.explore/repos`: list cached repositories, `git fetch --tags --prune --no-recurse-submodules` for metadata only, then compare `HEAD...@{u}`.
   - Treat the status as awareness, not permission to mutate. Fetching remote metadata is OK; do not pull, merge, rebase, reset, or checkout unless the task actually requires a fresher checkout.
   - Use the reported commit lag plus semver tag gap to judge staleness. A major or minor semver gap, or many commits behind, usually means refresh before current-code exploration; a patch gap or a few commits behind may be fine for stable historical inspection.

2. Check whether the target repository is already present in `~/.explore/repos`.
   - Prefer a stable directory name based on the repository owner and name, such as `owner__repo`.
   - If the repository is already present, use that local checkout for exploration after considering the staleness status above.

3. If the repository is not present, clone it into `~/.explore/repos`, then explore it there.
   - Create `~/.explore/repos` first if it does not exist.
   - Clone with a clear destination path, for example:

```bash
mkdir -p ~/.explore/repos
git clone <repo-url> ~/.explore/repos/<owner>__<repo>
```

After opening the repository, inspect its local instructions and project metadata before making assumptions. Prefer `rg`, `rg --files`, and targeted file reads for exploration.
