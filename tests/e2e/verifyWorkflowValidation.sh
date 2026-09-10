#!/usr/bin/env bash
# Phase 4L pilot-readiness -- item 5, "Validate the human-operated lifecycle
# workflow". Extracts the EXACT "Validate inputs" shell logic from
# .github/workflows/tenant-lifecycle.yml (copied verbatim below -- if that
# step's script ever changes, this file must be updated to match, which is
# itself a useful tripwire) and runs it against a battery of forged/
# malicious tenant_id and confirmation values, entirely locally. This never
# dispatches the real GitHub Actions workflow, never touches GitHub, never
# runs against production -- it proves the validation GATE itself is sound
# before any Python script or secret is ever reached.
#
# Run: bash tests/e2e/verifyWorkflowValidation.sh

validate() {
  local TENANT_ID="$1" CONFIRMATION="$2"
  set -euo pipefail
  if [[ ! "$TENANT_ID" =~ ^t_[a-z0-9-]+$ ]]; then
    echo "::error::tenant_id '$TENANT_ID' does not match the required format ^t_[a-z0-9-]+\$"
    return 1
  fi
  if [[ "$TENANT_ID" == "t_los-tres-amigos" ]]; then
    echo "::error::Los Tres Amigos is not managed through this workflow -- it stays on its existing LEGACY_REPO pipeline (update-reviews.yml)"
    return 1
  fi
  if [[ "$CONFIRMATION" != "$TENANT_ID" ]]; then
    echo "::error::confirmation must exactly match tenant_id -- refusing to proceed"
    return 1
  fi
  echo "Validated tenant_id=$TENANT_ID"
  return 0
}

pass=0
fail=0

check_rejected() {
  local desc="$1" tid="$2" conf="$3"
  if (validate "$tid" "$conf") >/dev/null 2>&1; then
    echo "FAIL: $desc -- expected rejection, but validation ACCEPTED tenant_id='$tid' confirmation='$conf'"
    fail=$((fail+1))
  else
    echo "PASS: $desc"
    pass=$((pass+1))
  fi
}

check_accepted() {
  local desc="$1" tid="$2" conf="$3"
  if (validate "$tid" "$conf") >/dev/null 2>&1; then
    echo "PASS: $desc"
    pass=$((pass+1))
  else
    echo "FAIL: $desc -- expected acceptance, but validation REJECTED tenant_id='$tid' confirmation='$conf'"
    fail=$((fail+1))
  fi
}

echo "--- Malformed tenant_id must be rejected ---"
check_rejected "uppercase letters rejected"        "T_Pilot"                 "T_Pilot"
check_rejected "missing t_ prefix rejected"         "pilot-test"              "pilot-test"
check_rejected "path traversal rejected"            "t_../../etc/passwd"      "t_../../etc/passwd"
check_rejected "shell metacharacters rejected"       't_pilot; rm -rf /'       't_pilot; rm -rf /'
check_rejected "shell substitution rejected"         't_pilot$(whoami)'       't_pilot$(whoami)'
check_rejected "backtick injection rejected"         't_pilot`whoami`'        't_pilot`whoami`'
check_rejected "spaces rejected"                     "t_pilot test"           "t_pilot test"
check_rejected "empty tenant_id rejected"            ""                       ""
check_rejected "underscore-body rejected (not a-z0-9-)" "t_pilot_test"        "t_pilot_test"
check_rejected "newline-embedded rejected"           $'t_pilot\nrm -rf /'     $'t_pilot\nrm -rf /'

echo -e "\n--- Los Tres Amigos is categorically refused, even with matching confirmation ---"
check_rejected "LTA tenant_id refused outright"      "t_los-tres-amigos"      "t_los-tres-amigos"

echo -e "\n--- Confirmation mismatch must be rejected ---"
check_rejected "confirmation does not match tenant_id" "t_pilot-test-b"       "t_pilot-test-a"
check_rejected "confirmation subtly different (trailing space)" "t_pilot-test-b" "t_pilot-test-b "
check_rejected "empty confirmation against valid tenant_id" "t_pilot-test-b" ""

echo -e "\n--- Well-formed, non-LTA, matching confirmation must be accepted ---"
check_accepted "valid synthetic tenant accepted"     "t_pilot-test-b"         "t_pilot-test-b"
check_accepted "valid synthetic tenant with hyphens accepted" "t_pilot-test-b-active" "t_pilot-test-b-active"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
