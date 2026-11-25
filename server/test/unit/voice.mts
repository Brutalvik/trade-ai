// Which of a device's voices says "Order fulfilled" and "Sold" (web/src/voice.ts): an English,
// female one when the device has one. Browsers name their voices but do not say which are
// female, so the choice goes by the names real devices use. The lists below are what those
// devices offer.
import { check, expect, finish } from "../check.mts";
const { pickFemaleVoice, isFemaleVoice } = await import(new URL("../../../web/src/voice.ts", import.meta.url).href);
const pick = (voices: { name: string; lang: string; default?: boolean }[]) => pickFemaleVoice(voices)?.name ?? null;

const mac = [
  { name: "Albert", lang: "en-US" }, { name: "Bad News", lang: "en-US" }, { name: "Bells", lang: "en-US" }, { name: "Daniel", lang: "en-GB" }, { name: "Fred", lang: "en-US" },
  { name: "Karen", lang: "en-AU" }, { name: "Kathy", lang: "en-US" }, { name: "Moira", lang: "en-IE" }, { name: "Princess", lang: "en-US" }, { name: "Rishi", lang: "en-IN" },
  { name: "Samantha", lang: "en-US", default: true }, { name: "Tessa", lang: "en-ZA" }, { name: "Amélie", lang: "fr-CA" }, { name: "Zarvox", lang: "en-US" },
];
const chromeExtra = [{ name: "Google US English", lang: "en-US" }, { name: "Google UK English Female", lang: "en-GB" }, { name: "Google UK English Male", lang: "en-GB" }, { name: "Google español", lang: "es-ES" }];
expect("a Mac (Safari): Samantha, not a man's voice and not one of the joke voices", pick(mac), "Samantha");
expect("a Mac (Chrome, which adds Google's voices): still Samantha", pick([...chromeExtra, ...mac]), "Samantha");
expect("an iPhone", pick([{ name: "Daniel", lang: "en-GB" }, { name: "Karen", lang: "en-AU" }, { name: "Samantha", lang: "en-US" }]), "Samantha");
expect("Windows (Chrome): Zira, though the default voice there is David", pick([{ name: "Microsoft David - English (United States)", lang: "en-US", default: true }, { name: "Microsoft Mark - English (United States)", lang: "en-US" }, { name: "Microsoft Zira - English (United States)", lang: "en-US" }, ...chromeExtra]), "Microsoft Zira - English (United States)");
expect("Windows (Edge): one of its natural female voices, not Guy", pick([{ name: "Microsoft Guy Online (Natural) - English (United States)", lang: "en-US", default: true }, { name: "Microsoft Sonia Online (Natural) - English (United Kingdom)", lang: "en-GB" }, { name: "Microsoft Jenny Online (Natural) - English (United States)", lang: "en-US" }, { name: "Microsoft Aria Online (Natural) - English (United States)", lang: "en-US" }]), "Microsoft Jenny Online (Natural) - English (United States)");
expect("Chrome with only Google's voices: the US one (female) before the British female one, never the male one", [pick(chromeExtra), pick(chromeExtra.slice(1))], ["Google US English", "Google UK English Female"]);
expect("Android, where voices are named by code: the one marked female", pick([{ name: "en-us-x-iom#male_1-local", lang: "en-US" }, { name: "en-us-x-sfg#female_1-local", lang: "en-US" }, { name: "en-gb-x-gba#female_2-local", lang: "en_GB" }]), "en-us-x-sfg#female_1-local");
expect("a better version of a voice is preferred, and US English comes before British", [pick([{ name: "Samantha", lang: "en-US" }, { name: "Samantha (Enhanced)", lang: "en-US" }]), pick([{ name: "Serena (Premium)", lang: "en-GB" }, { name: "Ava", lang: "en-US" }])], ["Samantha (Enhanced)", "Ava"]);
expect("when no voice can be told to be a woman's, none is chosen (the device's own default then speaks)", [pick([{ name: "English United States", lang: "en_US", default: true }, { name: "English United Kingdom", lang: "en_GB" }]), pick([{ name: "Microsoft David - English (United States)", lang: "en-US" }]), pick([{ name: "Amélie", lang: "fr-CA" }, { name: "Google español", lang: "es-ES" }]), pick([{ name: "Princess", lang: "en-US" }, { name: "Kathy", lang: "en-US" }, { name: "Bells", lang: "en-US" }]), pick([])], [null, null, null, null, null]);
check("names are read as whole words: 'Female' is not 'Male', 'woman' is not 'man'", isFemaleVoice("Google UK English Female") && !isFemaleVoice("Google UK English Male") && isFemaleVoice("English (woman)") && !isFemaleVoice("English (man)") && !isFemaleVoice("Alex") && !isFemaleVoice("Avalon Male") && isFemaleVoice("Ava"), "");
finish();
