// Soft trade sounds, generated with the Web Audio API (no audio files).
//  buy    : gentle two-note chime
//  profit : soft rising three-note chime
//  loss   : soft, low, falling two-note tone
// Browsers only allow sound after the user has interacted with the page, so the
// audio engine is unlocked on the first tap/click/key press.

export type TradeSound = "buy" | "profit" | "loss";

const MUTE_KEY = "nexus-sounds-muted";
let ctx: AudioContext | null = null;

export const isMuted = () => localStorage.getItem(MUTE_KEY) === "1";
export const setMuted = (m: boolean) => localStorage.setItem(MUTE_KEY, m ? "1" : "0");

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}

// Call once at startup: resumes audio on the first user gesture (needed on iPhone/Safari and Chrome).
export function unlockAudioOnFirstGesture() {
  const unlock = () => {
    const c = audio();
    if (c && c.state === "suspended") void c.resume();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

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

const PATTERNS: Record<TradeSound, { freqs: number[]; gap: number; dur: number; volume: number }> = {
  buy: { freqs: [659.25, 880], gap: 0.12, dur: 0.35, volume: 0.07 }, // E5 -> A5
  profit: { freqs: [523.25, 659.25, 783.99], gap: 0.11, dur: 0.55, volume: 0.07 }, // C5 E5 G5, rising
  loss: { freqs: [329.63, 261.63], gap: 0.18, dur: 0.5, volume: 0.06 }, // E4 -> C4, falling
};

export function playTradeSound(kind: TradeSound) {
  if (isMuted()) return;
  const c = audio();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  const p = PATTERNS[kind];
  const t0 = c.currentTime + 0.02;
  p.freqs.forEach((f, i) => note(c, f, t0 + i * p.gap, p.dur, p.volume));
}
