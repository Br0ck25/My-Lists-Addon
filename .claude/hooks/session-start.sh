#!/bin/bash
# Keeps a cloud session's checkout in step with its remote branch.
# Cloud containers can start from an out-of-date, shallow clone. This fetches the
# current branch, unshallows it, and fast-forwards only (never overwrites work).
# It never fails the session: any problem is printed and the script exits 0.

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" || { echo "sync: detached HEAD, skipped"; exit 0; }

if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git fetch --unshallow --quiet origin "$branch" 2>/dev/null || git fetch --quiet origin "$branch" 2>/dev/null || { echo "sync: fetch failed, skipped"; exit 0; }
else
  git fetch --quiet origin "$branch" 2>/dev/null || { echo "sync: fetch failed, skipped"; exit 0; }
fi

remote="$(git rev-parse --verify --quiet FETCH_HEAD)" || { echo "sync: branch $branch not on remote, skipped"; exit 0; }
local_sha="$(git rev-parse HEAD)"
[ "$remote" = "$local_sha" ] && { echo "sync: $branch already up to date"; exit 0; }

if git merge-base --is-ancestor "$remote" HEAD; then
  echo "sync: local $branch is ahead of remote, nothing to pull"; exit 0
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "sync: $branch is behind remote but there are uncommitted changes, NOT updated. Run git pull --ff-only yourself."; exit 0
fi
if git merge --ff-only --quiet "$remote" 2>/dev/null; then
  echo "sync: fast-forwarded $branch to $(git rev-parse --short HEAD)"
else
  echo "sync: $branch has diverged from remote, NOT updated. Ask the owner before merging."
fi
exit 0
