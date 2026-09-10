// Multi-Tenant Phase 4Q -- self-service registration email verification
// content. Mirrors accountEmailTemplate.js's shape exactly (purpose-built
// builder functions, local escapeHtml(), returns { html, text }) -- kept
// as a separate file rather than added to accountEmailTemplate.js since
// this is a genuinely different flow (verifying a NEW identity, not
// inviting/resetting an existing one) with its own copy.

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const BRAND = 'Pryor OS'

export function buildVerifyEmailSubject() {
  return `Verify your email for ${BRAND}`
}

export function buildVerifyEmail({ displayName, verifyUrl, expiresAt }) {
  const expiryText = new Date(expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
      <h2 style="margin-bottom: 4px;">Verify your email</h2>
      <p>Hi ${escapeHtml(displayName || '')},</p>
      <p>Thanks for registering for ${BRAND}. Confirm your email address to continue setting up your workspace.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(verifyUrl)}" style="background:#111827;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Verify email</a>
      </p>
      <p style="color:#6b7280;font-size:13px;">This link expires at ${expiryText} today and can only be used once. If you didn't request this, you can safely ignore this email -- no account will be created.</p>
    </div>`
  const text = `Verify your email for ${BRAND}\n\nHi ${displayName || ''},\n\nThanks for registering. Confirm your email address to continue: ${verifyUrl}\n\nThis link expires at ${expiryText} today and can only be used once. If you didn't request this, you can safely ignore this email.`
  return { html, text }
}
