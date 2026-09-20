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
  'test_login_ui_redesign.js',
  'test_google_social_auth.js',
  'test_data_endpoint.js',
  'test_middleware.js',
  'test_endpoint_auth.js',
  'test_oauth_safety.js',
  'test_google_oauth_error_contract.js',
  'test_google_oauth_tenant_scoping.js',
  'test_phase4b_cross_tenant_adversarial.js',
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
  'test_review_risk_classifier.js',
  'test_publish_urgent_gate.js',
  'test_mobile_auth_input_zoom.js',
  'test_review_email_workflow_frontend.js',
  'test_review_explorer_send_to_restaurant.js',
  'test_action_workspace_utils.js',
  'test_action_center_email_threads.js',
  'test_priority_digest.js',
  'test_executive_intelligence_center_ui.js',
  'test_executive_intelligence_prefetch.js',
  'test_rewrite_policy.js',
  'test_complaint_category_guide.js',
  'test_response_playbook_v2.js',
  'test_executive_brief.js',
  'test_ai_tenant_limits.js',
  'test_gbp_location_authorization.js',
  'test_intelligence_canonical_slug.js',
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
  'test_tenant_migration_policy.js',
  'test_tenant_session_authorization.js',
  'test_tenant_private_data_isolation.js',
  'test_tenant_location_catalog_isolation.js',
  'test_tenant_location_catalog_activation.js',
  'test_phase4o_automatic_provisioning.js',
  'test_tenant_location_ownership.js',
  'test_tenant_location_catalog_concurrency.js',
  'test_tenant_config_cross_language_consistency.js',
  'test_tenant_blob_keys_cross_language_consistency.js',
  'test_review_data_paths_provisioning.js',
  'test_provisioned_not_active.js',
  'test_provisioned_tenant_api_reads.js',
  'test_tenant_ops_endpoint.js',
  'test_tenant_entitlement_boundary.js',
  'test_entitlements.js',
  'test_plans.js',
  'test_location_seat_limits.js',
  'test_ai_usage_metering.js',
  'test_storage_commercial_quota.js',
  'test_commercial_feature_gating.js',
  'test_trial_lifecycle.js',
  'test_commercial_operation_policy.js',
  'test_google_reconnect_reconciliation.js',
  'test_credential_cas_concurrency.js',
  'test_tenant_entitlement_change.js',
  'test_session_tenant_status_endpoint.js',
  'test_onboarding_ui.js',
  'test_auth_gate_tenant_lifecycle_gate_ui.js',
  'test_tenant_branding_ui.js',
  'test_approved_locations_panel_ui.js',
  'test_use_tenant_status_hook_ui.js',
  'test_user_store_tenant_isolation.js',
  // Multi-Tenant Phase 4Q.1 -- self-service registration + access-code onboarding
  'test_pending_registration_store.js',
  'test_access_code_store.js',
  'test_registration.js',
  'test_tenant_creation_from_registration.js',
  'test_access_code_commercial_modernization.js',
  'test_prevent_shadow_tenant_creation.js',
  'test_tenant_creation_callers.js',
  'test_admin_access_codes_endpoint.js',
  // Multi-Tenant Google Integration Architecture Fix
  'test_google_connection_store.js',
  'test_google_integration_architecture.js',
  // Google Integration + Reviews End-to-End Validation
  'test_google_test_connection_permission.js',
  'test_multi_user_tenant_e2e.js',
  'test_reviews_date_scope_semantics.js',
  'test_google_sync_freshness.js',
  // Vercel Serverless Function Count Reduction
  'test_vercel_function_budget.js',
  // Phase B.10 -- Stripe SDK + Billing Store Foundation
  'test_stripe_client.js',
  'test_billing_store.js',
  'test_billing_status_projection.js',
  'test_stripe_price_map.js',
  'test_billing_portal_policy.js',
  'test_billing_foundation_compat.js',
  // Phase B.11 -- Pricing UX + Stripe Setup-mode Checkout
  'test_billing_customer.js',
  'test_select_plan_endpoint.js',
  'test_stripe_webhook.js',
  'test_pricing_page_ui.js',
  // Phase B.11 pre-commit correction -- self-service signup handoff,
  // trial-pending-activation, durable Customer-creation operation state,
  // extended consent snapshot, hardened Setup-completion validation.
  'test_self_service_commercial.js',
  'test_finalize_registration_endpoint.js',
  // Preview Infrastructure Isolation -- tenant lifecycle dispatch must
  // never let a Preview deployment execute against Production secrets.
  'test_preview_lifecycle_isolation.js',
  // B.11.5 -- independent, end-to-end synthetic-tenant onboarding
  // reliability test (register -> ... -> trial start -> entitlements).
  'test_b11_5_synthetic_onboarding_reliability.js',
  // Phase B.12 -- Stripe Subscription Activation (ensureSubscriptionActivation()).
  'test_subscription_activation.js',
  // Phase B.12 (Decision 1) -- primary event-driven billing-activation callback.
  'test_billing_activation_callback.js',
  // Phase B.13 -- Stripe Billing Customer Portal session creation.
  'test_billing_portal.js',
  // Phase B.13 -- owner-only, read-only canonical billing status endpoint.
  'test_billing_status.js',
  // Phase B.13.1 -- Owner Billing / Manage Subscription UI.
  'test_billing_ui.js',
  // PRYOR Complimentary Restaurant Access Codes
  'test_complimentary_access.js',
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
