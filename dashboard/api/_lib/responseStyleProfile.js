// Review Response Quality -- the smallest clean mechanism for a
// location/business response-style ("sounds like us") profile. No settings
// UI is built in this phase (deliberately out of scope -- see this
// feature's own spec: "Do not overbuild a full brand-voice CMS if
// unnecessary"). This module exists purely so prompt generation
// (rewriteEngine.js) is CONSISTENT and REUSABLE, and so a future settings
// UI (or per-tenant override) has one obvious place to plug into
// (resolveStyleProfile's `overrides` param) without another prompt-
// building rewrite. Every field here was previously either hardcoded
// inline in the prompt string (e.g. "a Mexican restaurant") or entirely
// absent.
export const DEFAULT_STYLE_PROFILE = Object.freeze({
  businessType: 'restaurant',
  cuisineType: 'Mexican',
  // 'warm-professional' | 'casual' | 'formal' -- currently descriptive only
  // (TONE_GUIDES in rewriteEngine.js still drives the actual per-reply
  // tone instruction); reserved for a future per-tenant default tone.
  formality: 'warm-professional',
  // false => "we" voice (the team/restaurant speaking); true => "I" voice
  // (an individual manager signing personally). Kept false by default,
  // matching the existing "— The {location} Team" sign-off exactly.
  managerSignsResponses: false,
  // Review Response Playbook v2, PART 1/PART 25: public Google review
  // replies must NOT carry an automatic signature by default -- a reply
  // ending "— The {location} Team" reads as an obvious AI/template
  // artifact, not something a real manager would type under a review.
  // This flag is the one on/off switch: false means buildSignOff() below
  // returns '' (the response simply ends after its final sentence, per
  // PART 2 -- no dash/name/"Sincerely,"-style closing either). Kept here,
  // not hardcoded in rewriteEngine.js, so a future tenant-level settings
  // UI has exactly one field to flip once a tenant explicitly wants a
  // signature back -- no prompt-building rewrite required for that.
  signatureEnabled: false,
  signOff: '— The {location} Team',
  preferredLanguage: 'en',
  // Phrases the model should avoid unless the specific situation genuinely
  // calls for very similar wording (PART 4 of this feature's spec) --
  // generic corporate/AI-sounding formulations, not concepts that can
  // never be expressed at all.
  phrasesToAvoid: [
    'Thank you for your valuable feedback.',
    'We sincerely apologize for any inconvenience.',
    'We sincerely apologize for any inconvenience caused.',
    'Your feedback is important to us.',
    'We value your feedback.',
    'We strive to provide excellent service.',
    'We deeply regret',
    'Please be assured',
    'We appreciate you taking the time to share your experience.',
    'We are committed to providing the highest level of service.',
    'We take all feedback very seriously.',
  ],
})

// Shallow-merges caller overrides over the defaults -- never mutates
// DEFAULT_STYLE_PROFILE itself. `phrasesToAvoid` is replaced wholesale
// (never merged/appended) when overridden, since a caller providing its
// own list has already made a deliberate choice about what belongs in it.
export function resolveStyleProfile(overrides = {}) {
  return { ...DEFAULT_STYLE_PROFILE, ...overrides }
}

// Returns '' (no sign-off at all) unless the style profile explicitly
// opts in via signatureEnabled -- see that field's own comment above.
export function buildSignOff(styleProfile, locationName) {
  if (!styleProfile.signatureEnabled) return ''
  return styleProfile.signOff.replace('{location}', locationName)
}

export function buildPhrasesToAvoidNote(styleProfile) {
  const phrases = styleProfile.phrasesToAvoid ?? []
  if (phrases.length === 0) return ''
  return `Avoid generic corporate phrases such as: ${phrases.map(p => `"${p}"`).join(', ')} — unless the specific situation genuinely calls for very similar wording. Write the way a real ${styleProfile.businessType} owner or manager actually talks, not like a corporate template.`
}
