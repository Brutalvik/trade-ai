// Trade sounds:
//  bought            a woman's voice says "Order fulfilled"
//  sold at a profit  a money sound, and half a second after it starts the voice says "Sold"
//  sold at a loss    a short buzzer, and half a second after it starts the voice says "Sold"
// The two sounds are recordings the owner chose (public/sounds/money.mp3, supplied by the owner,
// and buzzer-fail.wav: "System beep buzzer fail" from mixkit.co, used under Mixkit's free
// sound-effects licence). Until a recording has loaded, a generated sound stands in: a cash
// register, a buzzer. The words are spoken by the device's own speech engine, with a female
// English voice when the device has one (voice.ts); a device that cannot speak plays the sounds
// without the words, and a soft chime for a buy.
// Browsers only allow sound after the user has interacted with the page, so sound and speech are
// unlocked on the first tap/click/key press.
import { pickFemaleVoice } from "./voice";

export type TradeSound = "buy" | "profit" | "loss";

const MUTE_KEY = "nexus-sounds-muted";
let ctx: AudioContext | null = null;

export const isMuted = () => localStorage.getItem(MUTE_KEY) === "1";
export const setMuted = (m: boolean) => {
  localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  if (m) speech()?.cancel(); // muting also stops what is being said
};

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}

// ---------- The voice ----------
function speech(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null;
}
// The device's voices arrive a moment after the page loads (and some browsers send them later
// still), so the choice is made when they are there, and made again if the list changes.
let voice: SpeechSynthesisVoice | null = null;
function findVoice() {
  const all = speech()?.getVoices() ?? [];
  if (all.length) voice = pickFemaleVoice(all);
}
let listening = false;
function watchVoices() {
  const s = speech();
  if (!s || listening) return;
  listening = true;
  findVoice();
  s.addEventListener?.("voiceschanged", findVoice);
}
// Says the words after `afterMs` (so they follow the sound). A newer announcement replaces one
// that has not been said yet. Returns false when this device cannot speak.
let sayTimer: number | undefined;
function say(text: string, afterMs: number): boolean {
  const s = speech();
  if (!s) return false;
  watchVoices();
  window.clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    if (isMuted()) return;
    if (!voice) findVoice();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else u.lang = "en-US";
    u.rate = 1;
    u.pitch = 1.05;
    u.volume = 0.95;
    // Chrome can drop words spoken straight after a cancel, so leave a breath in between.
    if (s.speaking || s.pending) {
      s.cancel();
      window.setTimeout(() => s.speak(u), 90);
    } else s.speak(u);
  }, afterMs);
  return true;
}

// Call once at startup: resumes audio on the first user gesture (needed on iPhone/Safari and
// Chrome), and lets the speech engine speak later without one (a silent word said now).
export function unlockAudioOnFirstGesture() {
  watchVoices();
  const unlock = () => {
    const c = audio();
    if (c && c.state === "suspended") void c.resume();
    if (c) for (const clip of Object.values(CLIPS)) loadClip(c, clip);
    const s = speech();
    if (s && !isMuted()) {
      const hush = new SpeechSynthesisUtterance(" ");
      hush.volume = 0;
      s.speak(hush);
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

// ---------- The recorded sounds ----------
// Each is fetched and decoded once (when sound is unlocked, or when first needed).
const VOICE_AFTER = 0.5; // the word is spoken this many seconds after its sound starts
// from = where in the recording its sound begins (found when it is loaded): playing starts there.
type Clip = { url: string; volume: number; buffer: AudioBuffer | null; from: number; loading: boolean };
const CLIPS: Record<"profit" | "loss", Clip> = {
  // The volumes bring the two recordings to about the same loudness (the buzzer is recorded
  // much louder than the money sound).
  profit: { url: "/sounds/money.mp3", volume: 1.2, buffer: null, from: 0, loading: false },
  loss: { url: "/sounds/buzzer-fail.wav", volume: 0.4, buffer: null, from: 0, loading: false },
};
// Where a recording's sound begins, in seconds. A recording can open with a moment of silence (an
// MP3 always does; the money sound has a fifth of a second), and the half second before the voice
// is counted from the first thing you hear, so that silence is skipped.
export function soundStart(channels: ArrayLike<number>[], sampleRate: number): number {
  let peak = 0;
  for (const d of channels) for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
  if (!(peak > 0) || !(sampleRate > 0)) return 0;
  let first = Infinity;
  for (const d of channels) {
    let i = 0;
    while (i < d.length && i < first && Math.abs(d[i]) < peak * 0.02) i++;
    first = Math.min(first, i);
  }
  return Number.isFinite(first) ? Math.max(0, first / sampleRate - 0.01) : 0;
}
function loadClip(c: AudioContext, clip: Clip) {
  if (clip.buffer || clip.loading) return;
  clip.loading = true;
  fetch(clip.url)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${clip.url}: HTTP ${r.status}`))))
    .then((bytes) => c.decodeAudioData(bytes))
    .then((buffer) => {
      clip.from = soundStart(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)), buffer.sampleRate);
      clip.buffer = buffer;
    })
    .catch(() => {
      clip.loading = false; // asked for again the next time it is needed
    });
}
// Plays a recording at t0, from where its sound begins, if it has loaded (false = not yet: the
// caller plays the generated stand-in). It plays in full for the first 0.4 s; then it is turned
// down, so that the word spoken at half a second is clear, with what is left of the sound ringing
// quietly under it.
function playClip(c: AudioContext, clip: Clip, t0: number): boolean {
  if (!clip.buffer) {
    loadClip(c, clip);
    return false;
  }
  const src = c.createBufferSource();
  src.buffer = clip.buffer;
  const gain = c.createGain();
  gain.gain.setValueAtTime(clip.volume, t0);
  gain.gain.setValueAtTime(clip.volume, t0 + 0.4);
  gain.gain.linearRampToValueAtTime(clip.volume * 0.15, t0 + VOICE_AFTER + 0.05);
  gain.gain.linearRampToValueAtTime(0, t0 + 1.1);
  src.connect(gain).connect(c.destination);
  src.start(t0, clip.from);
  src.stop(t0 + 1.15);
  return true;
}

// ---------- The generated sounds ----------
// One soft note: sine wave with a quick fade-in and a gentle fade-out.
function note(c: AudioContext, freq: number, start: number, dur: number, volume: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}
// The gentle two-note chime (E5 -> A5): the preview when sounds are switched on, and a buy on a
// device that cannot speak.
function chime(c: AudioContext) {
  const t0 = c.currentTime + 0.02;
  [659.25, 880].forEach((f, i) => note(c, f, t0 + i * 0.12, 0.35, 0.07));
}

// A small bell: its note and the bright overtones that make it ring (a real bell's are not whole
// multiples of the note, which is what keeps it from sounding like a beep).
function bell(c: AudioContext, start: number, freq: number, volume: number, dur: number) {
  for (const [mult, vol, len] of [[1, 1, 1], [2.76, 0.45, 0.6], [5.4, 0.25, 0.35], [8.93, 0.12, 0.2]]) {
    if (freq * mult > 16_000) continue;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq * mult;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(volume * vol, start + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur * len);
    o.connect(g).connect(c.destination);
    o.start(start);
    o.stop(start + dur * len + 0.05);
  }
}
// A cash register: "ka" (the drawer's click: a burst of noise with a low knock under it), then
// "ching" (the bell, struck twice, the second a little higher and softer).
function cashRegister(c: AudioContext, t0: number) {
  const len = Math.floor(c.sampleRate * 0.05);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const click = c.createBufferSource();
  click.buffer = buf;
  const band = c.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 1800;
  band.Q.value = 0.8;
  const clickGain = c.createGain();
  clickGain.gain.value = 0.16;
  click.connect(band).connect(clickGain).connect(c.destination);
  click.start(t0);
  const knock = c.createOscillator();
  const knockGain = c.createGain();
  knock.type = "sine";
  knock.frequency.setValueAtTime(190, t0);
  knock.frequency.exponentialRampToValueAtTime(70, t0 + 0.07);
  knockGain.gain.setValueAtTime(0.14, t0);
  knockGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  knock.connect(knockGain).connect(c.destination);
  knock.start(t0);
  knock.stop(t0 + 0.12);
  bell(c, t0 + 0.1, 2093, 0.085, 0.9); // C7
  bell(c, t0 + 0.24, 2637, 0.06, 0.75); // E7
}
// A short, low buzzer: two rough tones a little apart, so they beat against each other.
// 0.36 seconds from start to silence.
function buzzer(c: AudioContext, t0: number) {
  const dur = 0.36;
  const soften = c.createBiquadFilter();
  soften.type = "lowpass";
  soften.frequency.value = 900;
  const gain = c.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.075, t0 + 0.012);
  gain.gain.setValueAtTime(0.075, t0 + dur - 0.05);
  gain.gain.linearRampToValueAtTime(0, t0 + dur);
  for (const f of [110, 116.5]) {
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    o.connect(soften);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
  soften.connect(gain).connect(c.destination);
}

export function playTradeSound(kind: TradeSound) {
  if (isMuted()) return;
  const c = audio();
  if (c && c.state === "suspended") void c.resume();
  if (kind === "buy") {
    if (!say("Order fulfilled", 0) && c) chime(c);
    return;
  }
  if (c) {
    const t0 = c.currentTime + 0.02;
    if (!playClip(c, CLIPS[kind], t0)) (kind === "profit" ? cashRegister : buzzer)(c, t0);
  }
  say("Sold", c ? Math.round(VOICE_AFTER * 1000) : 0);
}

// A quick chime when sounds are switched back on, so you know they are.
export function playSoundPreview() {
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  chime(c);
}
