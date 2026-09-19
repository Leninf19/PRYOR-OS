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
  signOff: '— The {location} Team',
  preferredLanguage: 'en',
  // Phrases the model should avoid unless the specific situation genuinely
  // calls for very similar wording (PART 2 of this feature's spec).
  phrasesToAvoid: [
    'We sincerely apologize for any inconvenience caused.',
    'We value your feedback.',
    'Your feedback is important to us.',
    'We strive to provide excellent service.',
    'Please be assured',
    'We deeply regret',
  ],
})

// Shallow-merges caller overrides over the defaults -- never mutates
// DEFAULT_STYLE_PROFILE itself. `phrasesToAvoid` is replaced wholesale
// (never merged/appended) when overridden, since a caller providing its
// own list has already made a deliberate choice about what belongs in it.
export function resolveStyleProfile(overrides = {}) {
  return { ...DEFAULT_STYLE_PROFILE, ...overrides }
}

export function buildSignOff(styleProfile, locationName) {
  return styleProfile.signOff.replace('{location}', locationName)
}

export function buildPhrasesToAvoidNote(styleProfile) {
  const phrases = styleProfile.phrasesToAvoid ?? []
  if (phrases.length === 0) return ''
  return `Avoid generic corporate phrases such as: ${phrases.map(p => `"${p}"`).join(', ')} — unless the specific situation genuinely calls for very similar wording. Write the way a real ${styleProfile.businessType} owner or manager actually talks, not like a corporate template.`
}
