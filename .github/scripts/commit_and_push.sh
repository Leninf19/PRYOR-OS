#!/usr/bin/env bash
# Shared, concurrency-safe commit+push helper for every workflow that
# commits generated files to main: critical-alert-check.yml,
# update-reviews.yml, nightly-digest.yml, health-check.yml,
# historical-import.yml. All five already serialize against EACH OTHER via
# the `reviews-db-writer` concurrency group (see update-reviews.yml's own
# header comment) -- so two of these workflows racing on the SAME file
# should never reach this script at all. What this handles is a push
# rejected by a commit that landed on main from OUTSIDE that group (a
# manual/administrative push, a workflow not in the group, etc.) -- that
# was the actual, mundane cause of the "main -> main (fetch first)"
# rejection this script was written for, not a flaw in the concurrency
# design.
#
# Usage: commit_and_push.sh "<commit message>" <file> [<file> ...]
#
# Exit code contract:
#   0 -- pushed successfully, OR there was genuinely nothing to commit/push
#        to begin with, OR (after rebasing onto a newer main) there was
#        nothing left to push because an equivalent commit already exists
#        upstream. All three are workflow SUCCESS -- a git-level race with
#        no real data lost is not an application error.
#   1 -- a real, unresolvable problem: a genuine rebase CONFLICT (this run
#        and a concurrent commit touched the SAME file -- see below for
#        why this is never auto-resolved), or the push still failing after
#        exhausting retries. Both are left as workflow FAILURE so a human
#        notices.
#
# Why a conflict is never auto-resolved: this project already suffered a
# real data-loss incident (2026-07-16) from an earlier version of this
# logic that reset-and-recommitted on a rejected push, which silently
# overwrote newer review data with an older run's stale copy. Automatically
# picking a side during a genuine conflict here would reintroduce exactly
# that risk. A conflict should be structurally impossible under the
# reviews-db-writer concurrency group; if one ever happens, that itself is
# the bug worth a human's attention, not something to paper over.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "::error::commit_and_push.sh: usage: commit_and_push.sh \"<message>\" <file> [<file> ...]"
  exit 1
fi

commit_msg="$1"
shift

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add "$@"
if git diff --staged --quiet; then
  echo "commit_and_push.sh: nothing to commit -- skipping."
  exit 0
fi
git commit -m "$commit_msg"

max_attempts=5
attempt=1
while [ "$attempt" -le "$max_attempts" ]; do
  if git push; then
    echo "commit_and_push.sh: pushed successfully on attempt $attempt."
    exit 0
  fi

  echo "commit_and_push.sh: push rejected (attempt $attempt/$max_attempts) -- fetching origin/main and rebasing..."
  git fetch origin main

  if ! git rebase origin/main; then
    git rebase --abort
    echo "::error::commit_and_push.sh: rebase hit a genuine conflict -- this run and a concurrent commit both touched the same file(s). This should be impossible under the reviews-db-writer concurrency group; refusing to auto-resolve it, since guessing which side 'wins' risks silently discarding review data (exactly the 2026-07-16 incident this project already suffered). This run's changes were NOT saved -- investigate immediately rather than re-running blindly."
    exit 1
  fi

  if [ -z "$(git log origin/main..HEAD --oneline)" ]; then
    echo "commit_and_push.sh: no changes remain after rebasing onto the latest main -- an equivalent commit already exists upstream, nothing left to push."
    exit 0
  fi

  attempt=$((attempt + 1))
done

echo "::error::commit_and_push.sh: git push still rejected after $max_attempts attempts -- main kept moving faster than this run could keep up, or a persistent problem exists. This run's changes were NOT saved. Re-run this workflow once main is stable."
exit 1
