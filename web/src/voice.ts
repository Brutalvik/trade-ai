// Which of the device's voices says "Order fulfilled" and "Sold".
// The words are spoken by the browser's own speech engine (no audio files), so the voice is one
// the device has. This picks an English, female one when the device has one that can be told
// apart by its name: browsers give a voice a name and a language, not a gender. No DOM in here,
// so it can be tested on its own.

export type VoiceInfo = { name: string; lang: string; default?: boolean; localService?: boolean };

// Female English voices by name: Apple (Samantha, Ava, ...), Microsoft (Zira, Jenny, Aria, ...),
// Android and Amazon names. "Google US English" (Chrome) is a female voice too.
const FEMALE_NAME = /\b(samantha|ava|allison|susan|victoria|karen|moira|tessa|fiona|serena|kate|zoe|nicky|joelle|noelle|stephanie|martha|flo|sandy|shelley|zira|hazel|jenny|aria|michelle|sonia|libby|natasha|emma|clara|molly|catherine|linda|heather|amy|joanna|salli|kendra|kimberly|ivy|olivia|nova|shimmer)\b|^google us english$/i;
// The words themselves, also inside names like "en-us-x-sfg#female_1-local" (Android).
const FEMALE_WORD = /(^|[^a-z])(female|woman)([^a-z]|$)/i;
const MALE_WORD = /(^|[^a-z])(male|man)([^a-z]|$)/i;
// The Mac's joke voices are never picked.
const NOVELTY = /\b(bells|bad news|good news|bubbles|cellos|jester|organ|superstar|trinoids|whisper|wobble|zarvox|boing|bahh|deranged|hysterical|princess|kathy|grandma)\b/i;
const BETTER = /\b(enhanced|premium|natural|neural|online|siri)\b/i;

export const isFemaleVoice = (name: string) => FEMALE_WORD.test(name) || (FEMALE_NAME.test(name) && !MALE_WORD.test(name));

// The best female English voice in the list, or null when none can be told to be one (then the
// device's default voice speaks). US English first, then British, then any other English.
export function pickFemaleVoice<V extends VoiceInfo>(voices: readonly V[]): V | null {
  let best: V | null = null, bestScore = -1;
  for (const v of voices) {
    const lang = v.lang.replace("_", "-").toLowerCase();
    if (!lang.startsWith("en") || NOVELTY.test(v.name) || !isFemaleVoice(v.name)) continue;
    const score = (lang === "en-us" ? 30 : lang === "en-gb" ? 20 : 10) + (BETTER.test(v.name) ? 5 : 0) + (/^samantha\b|^google us english$|\b(jenny|aria|zira)\b/i.test(v.name) ? 3 : 0) + (v.default ? 1 : 0);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}
