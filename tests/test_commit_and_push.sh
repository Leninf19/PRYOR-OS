#!/usr/bin/env bash
# Regression tests for .github/scripts/commit_and_push.sh -- the
# dirty-worktree rebase fix (post-mortem: Update Reviews run #369).
#
# Every test builds a REAL temporary bare "origin" repo plus one or more
# real temporary clones (a "runner" clone that invokes the script under
# test, and sometimes a "racer" clone that simulates a concurrent writer
# pushing to the same remote) -- never a mock, never the real PRYOR-OS
# repo. Everything lives under one mktemp -d root, removed on exit.
#
# Run directly: bash tests/test_commit_and_push.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../.github/scripts/commit_and_push.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

results=()

run() {
  local name="$1"; local fn="$2"
  if "$fn" > "$ROOT/last_test_output.log" 2>&1; then
    echo "PASS: $name"
    results+=("PASS")
  else
    echo "FAIL: $name"
    sed 's/^/    /' "$ROOT/last_test_output.log"
    results+=("FAIL")
  fi
}

# --- Fixture helpers ---------------------------------------------------

git_id() {
  git config user.name "Test Runner"
  git config user.email "test-runner@example.invalid"
}

# Creates a bare "origin" repo at $1, seeded with an initial commit on
# main containing every path listed via subsequent args as "name=content"
# pairs.
new_origin() {
  local origin_path="$1"; shift
  local seed="$origin_path.seed"
  git init -q --bare "$origin_path"
  # The bare repo's HEAD may default to a different branch name than the
  # "main" this whole suite pushes to (depends on the machine's global
  # init.defaultBranch) -- without this, HEAD would point at a ref that
  # never gets created, and every subsequent clone would silently fall
  # back to an empty, unrelated root commit instead of the seeded history.
  git --git-dir="$origin_path" symbolic-ref HEAD refs/heads/main
  git init -q "$seed"
  ( cd "$seed" && git_id && git checkout -q -b main
    for pair in "$@"; do
      local name="${pair%%=*}" content="${pair#*=}"
      mkdir -p "$(dirname "$name")"
      printf '%s' "$content" > "$name"
      git add -- "$name"
    done
    git commit -q -m "seed"
    git remote add origin "$origin_path"
    git push -q origin main
  )
  rm -rf "$seed"
}

# Clones $1 (a bare origin path) into $2, on branch main, with git
# identity configured.
clone_into() {
  git clone -q "$1" "$2"
  ( cd "$2" && git_id )
}

# --- Test 1: first-attempt push succeeds ------------------------------

test_first_attempt_push_succeeds() {
  local origin="$ROOT/t1_origin" runner="$ROOT/t1_runner"
  new_origin "$origin" "a.txt=one" "b.txt=two"
  clone_into "$origin" "$runner"
  ( cd "$runner"
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1
  local remote_content
  remote_content="$(git --git-dir="$origin" show main:a.txt)"
  [ "$remote_content" = "one-updated" ]
}

# --- Test 2/3: remote advances, retry succeeds with a clean tree ------

test_remote_advances_retry_succeeds_clean_tree() {
  local origin="$ROOT/t23_origin" runner="$ROOT/t23_runner" racer="$ROOT/t23_racer"
  new_origin "$origin" "a.txt=one" "src.py=print(1)"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"

  # Racer pushes an unrelated change first -- origin/main advances before
  # the runner ever tries to push.
  ( cd "$racer" && printf '%s' "print(2)" > src.py && git commit -qam "racer change" && git push -q origin main )

  ( cd "$runner"
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  [ "$(git --git-dir="$origin" show main:a.txt)" = "one-updated" ] &&
  [ "$(git --git-dir="$origin" show main:src.py)" = "print(2)" ]
}

# --- Test 4/5: retry succeeds with unrelated dirty tracked files, ------
# restored byte-for-byte -------------------------------------------------

test_dirty_tracked_files_restored_byte_for_byte() {
  local origin="$ROOT/t45_origin" runner="$ROOT/t45_runner" racer="$ROOT/t45_racer"
  new_origin "$origin" "a.txt=one" "generated1.json={\"n\":1}" "generated2.json={\"n\":2}"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && printf '%s' "one-from-racer" > /dev/null; echo "racer-extra" > extra.txt && git add extra.txt && git commit -qam "racer adds a file" && git push -q origin main )

  local dirty1='{"n":1,"dirty":true}'
  local dirty2='{"n":2,"dirty":true}'
  ( cd "$runner"
    printf '%s' "$dirty1" > generated1.json
    printf '%s' "$dirty2" > generated2.json
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  [ "$(cat "$runner/generated1.json")" = "$dirty1" ] &&
  [ "$(cat "$runner/generated2.json")" = "$dirty2" ] &&
  [ "$(git --git-dir="$origin" show main:a.txt)" = "one-updated" ]
}

# --- Test 6: relevant untracked files are preserved ---------------------

test_untracked_files_preserved() {
  local origin="$ROOT/t6_origin" runner="$ROOT/t6_runner" racer="$ROOT/t6_racer"
  new_origin "$origin" "a.txt=one"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && echo "b" > b.txt && git add b.txt && git commit -qam "racer" && git push -q origin main )

  ( cd "$runner"
    echo "brand-new-untracked-content" > untracked_report.txt
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  [ "$(cat "$runner/untracked_report.txt")" = "brand-new-untracked-content" ]
}

# --- Test 7: only explicitly authorized paths enter the commit ---------

test_only_authorized_paths_committed() {
  local origin="$ROOT/t7_origin" runner="$ROOT/t7_runner" racer="$ROOT/t7_racer"
  new_origin "$origin" "a.txt=one" "generated.json={}"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && echo "b" > b.txt && git add b.txt && git commit -qam "racer" && git push -q origin main )

  ( cd "$runner"
    printf '%s' '{"dirty":true}' > generated.json
    echo "untracked-noise" > noise.txt
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  local pushed_sha changed_files
  pushed_sha="$(git --git-dir="$origin" log --format=%H -1 --grep="update a")"
  changed_files="$(git --git-dir="$origin" diff-tree --no-commit-id --name-only -r "$pushed_sha")"
  [ "$changed_files" = "a.txt" ]
}

# --- Test 8: remote unrelated source changes survive -------------------

test_remote_unrelated_changes_survive() {
  local origin="$ROOT/t8_origin" runner="$ROOT/t8_runner" racer="$ROOT/t8_racer"
  new_origin "$origin" "a.txt=one" "src.py=print('old')"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && printf '%s' "print('new')" > src.py && git commit -qam "racer" && git push -q origin main )

  ( cd "$runner"
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  [ "$(git --git-dir="$origin" show main:src.py)" = "print('new')" ]
}

# --- Test 9: simultaneous edits to the SAME authorized file -> safe -----
# conflict, nonzero exit, local commit never lost ------------------------

test_same_file_conflict_is_safe_and_nonzero() {
  local origin="$ROOT/t9_origin" runner="$ROOT/t9_runner" racer="$ROOT/t9_racer"
  new_origin "$origin" "a.txt=line1"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && printf '%s' "line1-racer-version" > a.txt && git commit -qam "racer" && git push -q origin main )

  local before_head status
  ( cd "$runner"
    printf '%s' "line1-runner-version" > a.txt
    git_id
    bash "$SCRIPT" "update a" a.txt
  )
  status=$?
  [ "$status" -ne 0 ] || { echo "expected nonzero exit, got 0"; return 1; }

  # The runner's own local commit must still exist (never silently
  # discarded), and origin must remain exactly at the racer's version --
  # never force-overwritten.
  ( cd "$runner" && git log --format=%s -1 | grep -q "update a" ) &&
  [ "$(git --git-dir="$origin" show main:a.txt)" = "line1-racer-version" ]
}

# --- Test 10/11: rebase-refusal-before-start is never mislabeled as a ---
# conflict, and `git rebase --abort` is never called with nothing to -----
# abort -- direct unit test of the extracted rebase_in_progress() helper -

extract_rebase_in_progress_fn() {
  sed -n '/^rebase_in_progress() {/,/^}/p' "$SCRIPT"
}

test_rebase_in_progress_detection_is_accurate() {
  local fn_src fake_git_dir
  fn_src="$(extract_rebase_in_progress_fn)"
  [ -n "$fn_src" ] || { echo "could not extract rebase_in_progress() from the script"; return 1; }

  fake_git_dir="$(mktemp -d)"
  # Case A: no rebase directories present -- must report false (exit != 0).
  if ( git_dir="$fake_git_dir"; eval "$fn_src"; rebase_in_progress ); then
    echo "expected rebase_in_progress to be false with no rebase-merge/rebase-apply dir"
    rm -rf "$fake_git_dir"; return 1
  fi

  # Case B: a rebase-merge directory present -- must report true (exit 0).
  mkdir -p "$fake_git_dir/rebase-merge"
  if ! ( git_dir="$fake_git_dir"; eval "$fn_src"; rebase_in_progress ); then
    echo "expected rebase_in_progress to be true when rebase-merge/ exists"
    rm -rf "$fake_git_dir"; return 1
  fi
  rm -rf "$fake_git_dir"

  # Case C: a rebase-apply directory present -- must also report true.
  fake_git_dir="$(mktemp -d)"
  mkdir -p "$fake_git_dir/rebase-apply"
  if ! ( git_dir="$fake_git_dir"; eval "$fn_src"; rebase_in_progress ); then
    echo "expected rebase_in_progress to be true when rebase-apply/ exists"
    rm -rf "$fake_git_dir"; return 1
  fi
  rm -rf "$fake_git_dir"
  return 0
}

test_rebase_abort_only_called_when_guarded() {
  # Static proof that every ACTUAL "git rebase --abort" invocation (never
  # a mention in a comment/prose) appears inside an
  # `if rebase_in_progress; then` block -- exactly the run #369 bug fix
  # (the OLD script called it unconditionally).
  local abort_lines line guard_nearby found=0
  abort_lines="$(grep -n '^\s*git rebase --abort\s*$' "$SCRIPT" | cut -d: -f1)"
  [ -n "$abort_lines" ] || { echo "script no longer calls git rebase --abort at all"; return 1; }
  for line in $abort_lines; do
    found=1
    guard_nearby="$(sed -n "$((line-8)),${line}p" "$SCRIPT" | grep -c 'if rebase_in_progress')"
    [ "$guard_nearby" -ge 1 ] || { echo "git rebase --abort at line $line is not guarded by rebase_in_progress"; return 1; }
  done
  [ "$found" -eq 1 ]
}

# --- Test 12: restoration conflict does not destroy preserved changes ---

test_restoration_conflict_preserves_stash() {
  local origin="$ROOT/t12_origin" runner="$ROOT/t12_runner" racer="$ROOT/t12_racer"
  new_origin "$origin" "a.txt=one" "shared_generated.json={\"v\":1}"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  # Racer ALSO changes the same "generated" file the runner will leave dirty.
  ( cd "$racer" && printf '%s' '{"v":2,"from":"racer"}' > shared_generated.json && git commit -qam "racer" && git push -q origin main )

  local runner_dirty_content='{"v":1,"from":"runner-dirty"}'
  local status
  ( cd "$runner"
    printf '%s' "$runner_dirty_content" > shared_generated.json
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  )
  status=$?
  [ "$status" -ne 0 ] || { echo "expected nonzero exit on a restoration conflict"; return 1; }

  ( cd "$runner" && git stash list | grep -q "commit-and-push-" )
}

# --- Test 13: repeated push rejection respects the retry limit ----------

test_retry_limit_respected() {
  # Deterministic (not a real race): a `git` shim on PATH makes every
  # `push` fail unconditionally while passing every other git command
  # through to the real binary unchanged -- proving the script gives up
  # after exactly its bounded number of attempts, independent of real
  # network/filesystem timing.
  local origin="$ROOT/t13_origin" runner="$ROOT/t13_runner"
  new_origin "$origin" "a.txt=one"
  clone_into "$origin" "$runner"

  local real_git shim_dir
  real_git="$(command -v git)"
  shim_dir="$ROOT/t13_shim"
  mkdir -p "$shim_dir"
  cat > "$shim_dir/git" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "push" ]; then
  echo "fake-git: push always rejected (test double)" >&2
  exit 1
fi
exec "$real_git" "\$@"
EOF
  chmod +x "$shim_dir/git"

  local output status
  output="$( cd "$runner"
    printf '%s' "one-updated" > a.txt
    PATH="$shim_dir:$PATH" bash "$SCRIPT" "update a" a.txt 2>&1
  )"
  status=$?
  echo "$output" | grep -q "attempt 5/5"
  local saw_attempt5=$?
  [ "$status" -ne 0 ] && [ "$saw_attempt5" -eq 0 ]
}

# --- Test 14: no force-push is ever used (static + behavioral) ---------

test_no_force_push_used() {
  ! grep -Eq 'git push[^\n]*(--force|-f\b)' "$SCRIPT"
}

# --- Test 15: successful completion leaves no residue -------------------

test_no_residue_after_success() {
  local origin="$ROOT/t15_origin" runner="$ROOT/t15_runner" racer="$ROOT/t15_racer"
  new_origin "$origin" "a.txt=one" "generated.json={}"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && echo "b" > b.txt && git add b.txt && git commit -qam "racer" && git push -q origin main )

  ( cd "$runner"
    printf '%s' '{"dirty":true}' > generated.json
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  ( cd "$runner"
    [ -z "$(git stash list)" ] &&
    [ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] &&
    [ "$(git branch --format='%(refname:short)' | tr '\n' ' ' | xargs)" = "main" ]
  )
}

# --- Test 16: no-change operation creates no commit ---------------------

test_no_change_creates_no_commit() {
  local origin="$ROOT/t16_origin" runner="$ROOT/t16_runner"
  new_origin "$origin" "a.txt=one"
  clone_into "$origin" "$runner"

  local before after
  ( cd "$runner" && before="$(git rev-parse HEAD)"
    bash "$SCRIPT" "no-op" a.txt   # a.txt is already exactly what's committed
    after="$(git rev-parse HEAD)"
    [ "$before" = "$after" ]
  )
}

# --- Test 17: an equivalent remote update creates no duplicate commit ---

test_equivalent_remote_update_no_duplicate() {
  local origin="$ROOT/t17_origin" runner="$ROOT/t17_runner" racer="$ROOT/t17_racer"
  new_origin "$origin" "a.txt=one" "src.py=v0"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"

  # Racer pushes the EXACT SAME end-state the runner is about to produce.
  ( cd "$racer" && printf '%s' "one-updated" > a.txt && git commit -qam "update a" && git push -q origin main )

  local before_remote_count after_remote_count
  before_remote_count="$(git --git-dir="$origin" log main --oneline | wc -l)"

  ( cd "$runner"
    printf '%s' "one-updated" > a.txt
    bash "$SCRIPT" "update a" a.txt
  ) || return 1

  after_remote_count="$(git --git-dir="$origin" log main --oneline | wc -l)"
  # No new commit should have been pushed -- the rebase found the runner's
  # own patch already applied and dropped it as empty.
  [ "$before_remote_count" = "$after_remote_count" ]
}

# --- Test 18: filenames containing spaces are handled safely -----------

test_filenames_with_spaces_handled_safely() {
  local origin="$ROOT/t18_origin" runner="$ROOT/t18_runner" racer="$ROOT/t18_racer"
  new_origin "$origin" "review data.csv=one" "generated report.json={}"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"
  ( cd "$racer" && echo "b" > b.txt && git add b.txt && git commit -qam "racer" && git push -q origin main )

  ( cd "$runner"
    printf '%s' '{"dirty":true}' > "generated report.json"
    printf '%s' "one-updated" > "review data.csv"
    bash "$SCRIPT" "update review data" "review data.csv"
  ) || return 1

  [ "$(cat "$runner/generated report.json")" = '{"dirty":true}' ] &&
  [ "$(git --git-dir="$origin" show "main:review data.csv")" = "one-updated" ]
}

# --- Dedicated fixture: run #369 reproduction, 53 unrelated files -------

test_run_369_reproduction_53_files() {
  local origin="$ROOT/t369_origin" runner="$ROOT/t369_runner" racer="$ROOT/t369_racer"
  local seed_args=("reviews.csv=csv-v0" "reviews.db=db-v0")
  local i
  for i in $(seq 1 53); do
    seed_args+=("dashboard/private-data/generated_$i.json={\"n\":$i}")
  done
  new_origin "$origin" "${seed_args[@]}"
  clone_into "$origin" "$runner"
  clone_into "$origin" "$racer"

  # Simulates the actual incident: an out-of-band administrative push
  # (a source merge) lands on main while this run is mid-pipeline.
  ( cd "$racer" && echo "print(1)" > app.py && git add app.py && git commit -qam "concurrent admin merge" && git push -q origin main )

  local snapshot_dir="$ROOT/t369_before"
  mkdir -p "$snapshot_dir"
  ( cd "$runner"
    # Simulates "Export intelligence data"/"Refresh analytics" dirtying
    # every one of the 53 generated files, exactly like the real pipeline.
    for i in $(seq 1 53); do
      printf '{"n":%s,"regenerated":true}' "$i" > "dashboard/private-data/generated_$i.json"
    done
    cp -r dashboard/private-data "$snapshot_dir/private-data-before"
    printf '%s' "csv-v1" > reviews.csv
    printf '%s' "db-v1" > reviews.db
    bash "$SCRIPT" "chore: pipeline run (+1 reviews) [skip ci]" reviews.csv reviews.db
  ) || return 1

  [ "$(git --git-dir="$origin" show main:reviews.csv)" = "csv-v1" ] &&
  [ "$(git --git-dir="$origin" show main:reviews.db)" = "db-v1" ] &&
  [ "$(git --git-dir="$origin" show main:app.py)" = "print(1)" ] || return 1

  for i in $(seq 1 53); do
    diff -q "$snapshot_dir/private-data-before/generated_$i.json" "$runner/dashboard/private-data/generated_$i.json" >/dev/null || {
      echo "generated_$i.json changed across the commit/rebase/push cycle"
      return 1
    }
  done
  return 0
}

main() {
  run "1: first-attempt push succeeds" test_first_attempt_push_succeeds
  run "2/3: remote advances before push, retry succeeds with a clean tree" test_remote_advances_retry_succeeds_clean_tree
  run "4/5: retry succeeds with dirty tracked files, restored byte-for-byte" test_dirty_tracked_files_restored_byte_for_byte
  run "6: relevant untracked files are preserved" test_untracked_files_preserved
  run "7: only explicitly authorized paths enter the commit" test_only_authorized_paths_committed
  run "8: remote unrelated source changes survive" test_remote_unrelated_changes_survive
  run "9: same-file conflict is safe, nonzero exit, commit never lost" test_same_file_conflict_is_safe_and_nonzero
  run "10/11: rebase_in_progress() detection is accurate (unit)" test_rebase_in_progress_detection_is_accurate
  run "10/11: git rebase --abort is only called inside a rebase_in_progress guard (static)" test_rebase_abort_only_called_when_guarded
  run "12: a restoration conflict never destroys the preserved stash" test_restoration_conflict_preserves_stash
  run "13: repeated push rejection respects the retry limit" test_retry_limit_respected
  run "14: no force-push is ever used" test_no_force_push_used
  run "15: successful completion leaves no rebase/stash/branch residue" test_no_residue_after_success
  run "16: a no-change operation creates no commit" test_no_change_creates_no_commit
  run "17: an equivalent remote update creates no duplicate commit" test_equivalent_remote_update_no_duplicate
  run "18: filenames containing spaces are handled safely" test_filenames_with_spaces_handled_safely
  run "run #369 reproduction: 53 unrelated generated files survive untouched" test_run_369_reproduction_53_files

  echo
  local pass=0 fail=0
  for r in "${results[@]}"; do
    if [ "$r" = "PASS" ]; then pass=$((pass+1)); else fail=$((fail+1)); fi
  done
  if [ "$fail" -eq 0 ]; then
    echo "ALL $pass TESTS PASSED"
    exit 0
  else
    echo "$fail of $((pass+fail)) TESTS FAILED"
    exit 1
  fi
}

main
