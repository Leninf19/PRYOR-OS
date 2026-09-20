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
#        why this is never auto-resolved), a restoration conflict after
#        rebasing, or the push still failing after exhausting retries.
#        All are left as workflow FAILURE so a human notices.
#
# Why a conflict is never auto-resolved: this project already suffered a
# real data-loss incident (2026-07-16) from an earlier version of this
# logic that reset-and-recommitted on a rejected push, which silently
# overwrote newer review data with an older run's stale copy. Automatically
# picking a side during a genuine conflict here would reintroduce exactly
# that risk. A conflict should be structurally impossible under the
# reviews-db-writer concurrency group; if one ever happens, that itself is
# the bug worth a human's attention, not something to paper over.
#
# DIRTY-WORKTREE REBASE FIX (post-mortem: Update Reviews run #369,
# 2026-09-20): every caller's OWN earlier pipeline steps (export/analytics
# regeneration) leave OTHER tracked files -- e.g. dashboard/private-data/*.json
# -- modified on disk, on purpose: those files must stay on disk, exactly as
# regenerated, for a LATER build/deploy step to bundle, but this script must
# NEVER commit them (only the explicit file arguments it was given). `git
# rebase` refuses to even start while ANY tracked file has uncommitted
# changes, regardless of whether that file is involved in the rebase at all
# -- run #369 hit exactly this ("cannot rebase: You have unstaged changes"),
# and the OLD script then called `git rebase --abort` unconditionally,
# which itself failed ("fatal: no rebase in progress", since no rebase had
# actually started) and killed the whole script under `set -e` before it
# ever printed its own intended diagnostic.
#
# The fix: once the authorized files are committed, this script's own
# retry loop STASHES everything else that is still dirty (tracked
# modifications + untracked-but-not-ignored files -- never anything
# .gitignore'd, so a secret-bearing local file like .env.local is never
# touched) under a unique, per-attempt tag before rebasing, then restores
# it immediately afterward -- so `git rebase` always sees a genuinely clean
# tree (the ACTUAL precondition it requires), and the unrelated dirty files
# are preserved byte-for-byte across the whole cycle. `git rebase --abort`
# is only ever called once this script has POSITIVELY CONFIRMED (by
# checking for the rebase-merge/rebase-apply directory) that a rebase is
# actually in progress -- never blindly.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "::error::commit_and_push.sh: usage: commit_and_push.sh \"<message>\" <file> [<file> ...]"
  exit 1
fi

commit_msg="$1"
shift

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -- "$@"
if git diff --staged --quiet; then
  echo "commit_and_push.sh: nothing to commit -- skipping."
  exit 0
fi
# A partial-path commit: commits only the given files even if something
# else were ever accidentally staged beforehand, and never touches any
# other file's staged/unstaged state.
git commit -m "$commit_msg" -- "$@"

if git push; then
  echo "commit_and_push.sh: pushed successfully on attempt 1."
  exit 0
fi

# --- Retry path: origin/main advanced since our commit ---------------------
#
# Every stash this script ever creates is tagged with a unique identifier
# (never a bare, ambient `stash@{0}`) and always resolved back by that
# exact tag -- via its own commit SHA (for `apply`, which accepts any
# commit-ish) and, separately, its own stash@{N} position (for `drop`,
# which requires an actual stash reference and rejects a bare SHA) --
# both captured together, at the same moment, so neither is ever stale or
# ambiguous by the time it is used.
run_tag="commit-and-push-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
git_dir="$(git rev-parse --git-dir)"

find_stash_sha() {
  # Prints the commit SHA of the stash entry tagged "$1", or nothing if
  # none exists. Matches on the stash's own message (%gs), never on
  # position (%gd), so identification is correct regardless of how many
  # other stash entries exist or in what order.
  git stash list --format='%H %gs' | awk -v tag="$1" 'index($0, tag) { print $1; exit }'
}

find_stash_positional_ref() {
  # `git stash drop` (unlike `apply`/`pop`) does not accept a bare commit
  # SHA -- it requires an actual stash@{N} reference. This resolves that
  # positional ref by the SAME unique tag, at the SAME moment as the SHA
  # above (both are captured before this script does anything else to the
  # stash list), so the position is never stale by the time it is used.
  git stash list --format='%gd %gs' | awk -v tag="$1" 'index($0, tag) { print $1; exit }'
}

restore_stash() {
  # Applies and, ONLY on success, drops the stash tagged "$1". Returns
  # nonzero (leaving the stash entry fully intact, never dropped) if the
  # tag cannot be found, if applying it conflicts with what the rebase
  # just changed (a "restoration conflict" -- a DIFFERENT failure mode
  # from a rebase conflict, and one that must never destroy the preserved
  # changes), or if the entry was applied but could not be dropped
  # afterward -- the latter still counts as failure here (even though the
  # working tree content IS correctly restored at that point) so that a
  # zero exit code from this function is always an unconditional guarantee
  # of "no stash residue remains," never a "probably fine" guess.
  local tag="$1" sha ref
  sha="$(find_stash_sha "$tag")"
  ref="$(find_stash_positional_ref "$tag")"
  if [ -z "$sha" ] || [ -z "$ref" ]; then
    echo "::error::commit_and_push.sh: could not find the stash tagged '$tag' to restore -- this should be impossible; investigate immediately."
    return 1
  fi
  if ! git stash apply "$sha"; then
    echo "::error::commit_and_push.sh: restoring stash $tag (commit $sha) conflicted with the rebased tree -- the stash was left in place, NOT dropped. Recover with: git stash list | grep $tag   then   git stash apply <that SHA>."
    return 1
  fi
  if ! git stash drop "$ref"; then
    echo "::error::commit_and_push.sh: stash $tag (commit $sha) was applied successfully -- the working tree IS correctly restored -- but 'git stash drop' itself failed, which would leave a stale stash entry. Treating this as a failure so it is never silently left behind: recover with 'git stash drop $ref' (or the equivalent SHA-based form) once investigated."
    return 1
  fi
  return 0
}

rebase_in_progress() {
  [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]
}

max_attempts=5
attempt=1
while [ "$attempt" -le "$max_attempts" ]; do
  echo "commit_and_push.sh: push rejected (attempt $attempt/$max_attempts) -- fetching origin/main and rebasing..."
  git fetch origin main

  attempt_tag="${run_tag}-${attempt}"
  stashed=false
  if [ -n "$(git status --porcelain)" ]; then
    # --include-untracked (NOT --all): captures tracked modifications and
    # untracked-but-relevant files (e.g. a newly regenerated report this
    # run also produced), but NEVER an ignored file (.env*, .vercel/,
    # backups/) -- stash push simply never looks at those without --all.
    git stash push --include-untracked -m "$attempt_tag"
    stashed=true
  fi

  if ! git rebase origin/main; then
    if rebase_in_progress; then
      # A GENUINE conflict: this run's own commit and a concurrent one
      # both touched the same authorized file's content. Never
      # auto-resolved -- see this script's header.
      git rebase --abort
      if [ "$stashed" = true ]; then
        restore_stash "$attempt_tag" || true
      fi
      echo "::error::commit_and_push.sh: rebase hit a genuine conflict -- this run and a concurrent commit both touched the same file(s). This should be impossible under the reviews-db-writer concurrency group; refusing to auto-resolve it, since guessing which side 'wins' risks silently discarding review data (exactly the 2026-07-16 incident this project already suffered). This run's changes were NOT saved -- investigate immediately rather than re-running blindly."
      exit 1
    fi
    # Rebase refused to even START -- NOT a content conflict (the exact
    # run #369 failure mode). With the stash already in place the tree
    # should be clean, so this should not recur; fail safe and loud
    # rather than guessing if it somehow still does. Never call
    # `git rebase --abort` here: rebase_in_progress() just proved there
    # is nothing to abort, and calling it anyway is precisely the bug
    # being fixed.
    if [ "$stashed" = true ]; then
      restore_stash "$attempt_tag" || true
    fi
    echo "::error::commit_and_push.sh: git rebase could not even start (this is NOT a content conflict -- no rebase was in progress to abort). Investigate what left the working tree unexpectedly dirty; this run's changes were NOT saved."
    exit 1
  fi

  if [ "$stashed" = true ]; then
    if ! restore_stash "$attempt_tag"; then
      # Restoration conflict: the rebase changed the SAME unrelated
      # file(s) this run had stashed out of the way. The stash is
      # intentionally left in place (never dropped) for manual recovery.
      exit 1
    fi
  fi

  if [ -z "$(git log origin/main..HEAD --oneline)" ]; then
    echo "commit_and_push.sh: no changes remain after rebasing onto the latest main -- an equivalent commit already exists upstream, nothing left to push."
    exit 0
  fi

  if git push; then
    echo "commit_and_push.sh: pushed successfully on attempt $attempt (after rebase)."
    exit 0
  fi

  attempt=$((attempt + 1))
done

echo "::error::commit_and_push.sh: git push still rejected after $max_attempts attempts -- main kept moving faster than this run could keep up, or a persistent problem exists. This run's changes were NOT saved. Re-run this workflow once main is stable."
exit 1
