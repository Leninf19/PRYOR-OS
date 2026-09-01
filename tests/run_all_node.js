// Runs every Node regression test in tests/ and reports a pass/fail summary
// -- the Node-side counterpart to run_all.py.
//
// Run directly: node tests/run_all_node.js

import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TESTS = [
  'test_publish_reply.js',
  'test_auth.js',
  'test_permissions.js',
  'test_authorization_matrix.js',
  'test_rate_limit.js',
  'test_action_store.js',
  'test_actions_endpoint.js',
  'test_session_accounts.js',
  'test_login.js',
  'test_data_endpoint.js',
  'test_middleware.js',
  'test_endpoint_auth.js',
  'test_oauth_safety.js',
  'test_google_oauth_error_contract.js',
  'test_http_methods.js',
  'test_workflow_concurrency.js',
  'test_no_direct_data_fetches.js',
  'test_provider_health_hook.js',
  'test_provider_health_ui.js',
  'test_account_context.js',
  'test_action_workspace_service.js',
  'test_action_center_collaboration.js',
  'test_review_email_config.js',
  'test_location_contacts_reader.js',
  'test_email_sender.js',
  'test_graph_mail_sender.js',
  'test_review_email_template.js',
  'test_send_review_email.js',
  'test_review_email_workflow_frontend.js',
  'test_review_explorer_send_to_restaurant.js',
  'test_action_workspace_utils.js',
  'test_action_center_email_threads.js',
  'test_priority_digest.js',
  'test_executive_intelligence_center_ui.js',
  'test_executive_intelligence_prefetch.js',
  'test_no_gmail_in_review_email_workflow.js',
  'test_settings_registry.js',
  'test_settings_routing.js',
  'test_google_action_dispatch.js',
  'test_contact_store.js',
  'test_settings_contacts_endpoint.js',
  'test_email_validation.js',
  'test_restaurant_contacts_ui.js',
  'test_contacts_backfill.js',
  'test_audit_log.js',
  'test_settings_audit_log_endpoint.js',
  'test_credential_store.js',
  'test_google_oauth_auto_recovery.js',
  'test_settings_email_status_endpoint.js',
  'test_settings_send_test_email.js',
  'test_email_system_ui.js',
  'test_audit_log_ui.js',
  'test_google_business_profile_ui.js',
  'test_google_oauth_quota_blocked.js',
  'test_data_utils.js',
  'test_sentiment_breakdown_ui.js',
  'test_filter_persistence.js',
  'test_filter_persistence_wiring.js',
  'test_filter_expiration.js',
  'test_user_store.js',
  'test_invitations.js',
  'test_accept_invite_ui.js',
  'test_password_reset.js',
  'test_password_reset_ui.js',
  'test_location_authorization.js',
  'test_frontend_location_scoping.js',
  'test_user_management.js',
  'test_users_access_ui.js',
  'test_security_hardening.js',
  'test_reviews_no_background_draft_generation.js',
  'test_reviews_auto_advance.js',
  'test_reviews_filter_cleanup.js',
  'test_notification_store.js',
  'test_notification_events.js',
  'test_notifications_endpoint.js',
  'test_notification_bell_ui.js',
  'test_today_page_ux.js',
  'test_task_recurrence.js',
  'test_task_store.js',
  'test_tasks_endpoint.js',
  'test_campaign_store.js',
  'test_content_endpoint.js',
  'test_tenant_model.js',
]

const results = {}
for (const name of TESTS) {
  console.log(`=== ${name} ===`)
  const proc = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit' })
  results[name] = proc.status === 0
  console.log()
}

console.log('=== Summary ===')
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`)
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([n]) => n)
if (failed.length === 0) {
  console.log(`\nALL ${TESTS.length} TEST FILES PASSED`)
  process.exit(0)
}
console.log(`\n${failed.length} of ${TESTS.length} TEST FILES FAILED: ${failed.join(', ')}`)
process.exit(1)
