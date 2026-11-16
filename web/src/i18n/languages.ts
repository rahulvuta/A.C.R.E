/*
  Languages a grower can pick by name (card 18). The app is not limited to this list: any
  language can be typed, and the service translates into whatever is named. The list only
  saves typing and tells the page which way the script runs.
*/
export interface Language {
  /** The English name, which is what the translator is asked for. */
  name: string;
  /** The name in the language itself, shown in the picker. */
  native: string;
  /** BCP 47 code, set on the page so screen readers pronounce it right. Empty when not known. */
  code: string;
  rtl?: boolean;
}

export const LANGUAGES: Language[] = [
  { name: "Spanish", native: "Español", code: "es" },
  { name: "French", native: "Français", code: "fr" },
  { name: "Portuguese", native: "Português", code: "pt" },
  { name: "Hindi", native: "हिन्दी", code: "hi" },
  { name: "Bengali", native: "বাংলা", code: "bn" },
  { name: "Swahili", native: "Kiswahili", code: "sw" },
  { name: "Arabic", native: "العربية", code: "ar", rtl: true },
  { name: "Chinese (Simplified)", native: "简体中文", code: "zh-Hans" },
  { name: "Indonesian", native: "Bahasa Indonesia", code: "id" },
  { name: "Urdu", native: "اردو", code: "ur", rtl: true },
  { name: "Punjabi", native: "ਪੰਜਾਬੀ", code: "pa" },
  { name: "Marathi", native: "मराठी", code: "mr" },
  { name: "Telugu", native: "తెలుగు", code: "te" },
  { name: "Tamil", native: "தமிழ்", code: "ta" },
  { name: "Gujarati", native: "ગુજરાતી", code: "gu" },
  { name: "Kannada", native: "ಕನ್ನಡ", code: "kn" },
  { name: "Nepali", native: "नेपाली", code: "ne" },
  { name: "Sinhala", native: "සිංහල", code: "si" },
  { name: "Hausa", native: "Hausa", code: "ha" },
  { name: "Yoruba", native: "Yorùbá", code: "yo" },
  { name: "Igbo", native: "Igbo", code: "ig" },
  { name: "Amharic", native: "አማርኛ", code: "am" },
  { name: "Oromo", native: "Afaan Oromoo", code: "om" },
  { name: "Somali", native: "Soomaali", code: "so" },
  { name: "Kinyarwanda", native: "Ikinyarwanda", code: "rw" },
  { name: "Luganda", native: "Luganda", code: "lg" },
  { name: "Zulu", native: "isiZulu", code: "zu" },
  { name: "Shona", native: "chiShona", code: "sn" },
  { name: "Chichewa", native: "Chichewa", code: "ny" },
  { name: "Malagasy", native: "Malagasy", code: "mg" },
  { name: "Wolof", native: "Wolof", code: "wo" },
  { name: "Vietnamese", native: "Tiếng Việt", code: "vi" },
  { name: "Thai", native: "ไทย", code: "th" },
  { name: "Burmese", native: "မြန်မာ", code: "my" },
  { name: "Khmer", native: "ខ្មែរ", code: "km" },
  { name: "Filipino", native: "Filipino", code: "fil" },
  { name: "Malay", native: "Bahasa Melayu", code: "ms" },
  { name: "Japanese", native: "日本語", code: "ja" },
  { name: "Korean", native: "한국어", code: "ko" },
  { name: "Turkish", native: "Türkçe", code: "tr" },
  { name: "Persian", native: "فارسی", code: "fa", rtl: true },
  { name: "Pashto", native: "پښتو", code: "ps", rtl: true },
  { name: "Hebrew", native: "עברית", code: "he", rtl: true },
  { name: "Russian", native: "Русский", code: "ru" },
  { name: "Ukrainian", native: "Українська", code: "uk" },
  { name: "Kazakh", native: "Қазақша", code: "kk" },
  { name: "Uzbek", native: "Oʻzbekcha", code: "uz" },
  { name: "German", native: "Deutsch", code: "de" },
  { name: "Italian", native: "Italiano", code: "it" },
  { name: "Dutch", native: "Nederlands", code: "nl" },
  { name: "Polish", native: "Polski", code: "pl" },
  { name: "Romanian", native: "Română", code: "ro" },
  { name: "Greek", native: "Ελληνικά", code: "el" },
  { name: "Quechua", native: "Runasimi", code: "qu" },
  { name: "Guarani", native: "Avañeʼẽ", code: "gn" },
  { name: "Haitian Creole", native: "Kreyòl ayisyen", code: "ht" },
];

const RTL_NAMES = /^(arabic|urdu|persian|farsi|dari|pashto|hebrew|sindhi|kurdish \(sorani\)|uyghur|yiddish|dhivehi)$/i;

/** The language for a name the grower typed: a listed one when it matches, otherwise the name as typed. */
export function languageFor(name: string): Language | null {
  const t = name.trim().replace(/\s+/g, " ");
  if (!t || /^english$/i.test(t)) return null;
  const hit = LANGUAGES.find((l) => l.name.toLowerCase() === t.toLowerCase() || l.native.toLowerCase() === t.toLowerCase() || l.code.toLowerCase() === t.toLowerCase());
  if (hit) return hit;
  // A language's name: letters, spaces, hyphens and brackets, as the service also checks.
  if (!/^\p{L}[\p{L} '()\-]{1,48}$/u.test(t)) return null;
  return { name: t.charAt(0).toUpperCase() + t.slice(1), native: t, code: "", rtl: RTL_NAMES.test(t) };
}
