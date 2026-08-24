// Invitation and password-reset email content -- Multi-Location
// Authentication & User Access System, Commit 2/3. Mirrors
// reviewEmailTemplate.js's shape exactly (purpose-built builder functions,
// local escapeHtml(), returns { html, text }, no template-file/i18n system)
// rather than inventing a generic template engine this codebase doesn't
// otherwise have.
//
// Every builder here is content-only -- it never decides WHETHER to send
// (that's the caller's job, same division of labor emailSender.js
// documents) and never receives a raw token, only the already-built URL.

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const BRAND = 'Future Insights'

export function buildInviteEmailSubject() {
  return `You've been invited to ${BRAND}`
}

// `locationIds`/`locationNames`: purely informational copy, never used for
// authorization. locationIds === '*' -> "all locations"; otherwise the
// resolved display names if available, or a generic scoped fallback if name
// resolution failed (never silently claims company-wide access for a
// genuinely scoped account).
export function buildInviteEmail({ name, role, locationIds, locationNames, inviteUrl, expiresAt }) {
  let scopeLine
  if (locationIds === '*') {
    scopeLine = 'You\'ll have access to all locations.'
  } else if (locationNames && locationNames.length) {
    scopeLine = `You'll have access to: ${locationNames.join(', ')}`
  } else {
    scopeLine = 'You\'ll have access to your assigned location(s).'
  }
  const expiryText = new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
      <h2 style="margin-bottom: 4px;">You've been invited to ${BRAND}</h2>
      <p>Hi ${escapeHtml(name || '')},</p>
      <p>You've been invited to join ${BRAND} as <strong>${escapeHtml(roleLabel(role))}</strong>. ${escapeHtml(scopeLine)}</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(inviteUrl)}" style="background:#111827;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Set up your account</a>
      </p>
      <p style="color:#6b7280;font-size:13px;">This link expires on ${expiryText} and can only be used once. If you weren't expecting this invitation, you can safely ignore this email.</p>
    </div>`
  const text = `You've been invited to ${BRAND}\n\nHi ${name || ''},\n\nYou've been invited to join ${BRAND} as ${roleLabel(role)}. ${scopeLine}\n\nSet up your account: ${inviteUrl}\n\nThis link expires on ${expiryText} and can only be used once.`
  return { html, text }
}

export function buildResetEmailSubject() {
  return `Reset your ${BRAND} password`
}

export function buildResetEmail({ name, resetUrl, expiresAt }) {
  const expiryText = new Date(expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
      <h2 style="margin-bottom: 4px;">Reset your password</h2>
      <p>Hi ${escapeHtml(name || '')},</p>
      <p>We received a request to reset your ${BRAND} password. Click below to choose a new one.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(resetUrl)}" style="background:#111827;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Reset password</a>
      </p>
      <p style="color:#6b7280;font-size:13px;">This link expires at ${expiryText} today and can only be used once. If you didn't request this, you can safely ignore this email -- your password will not be changed.</p>
    </div>`
  const text = `Reset your ${BRAND} password\n\nHi ${name || ''},\n\nWe received a request to reset your password. Use this link to choose a new one: ${resetUrl}\n\nThis link expires at ${expiryText} today and can only be used once. If you didn't request this, you can safely ignore this email.`
  return { html, text }
}

function roleLabel(role) {
  const labels = { owner: 'Owner', admin: 'Admin', marketing: 'Marketing', location_manager: 'Location Manager', read_only: 'Viewer' }
  return labels[role] ?? role
}
