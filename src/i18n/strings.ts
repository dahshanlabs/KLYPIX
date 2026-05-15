// Minimal translation layer. Not a full i18n framework — enough
// structure that adding a new string is one edit here plus the call
// site, no architectural work. Detects the user's locale once at
// startup via navigator.language and maps the prefix to a known
// language; anything unrecognized falls back to English.
//
// Usage:
//   import { t } from '@/i18n/strings';
//   t('zoom.expand.tooltip')  // → 'Zoom in to expand' or 'كبّر لعرض المحتوى'
//
// Adding a string: add the key to `Strings` with a translation per
// supported locale. Callers stay unchanged as locales are added.

type Locale = 'en' | 'ar';

type Strings = Record<string, Record<Locale, string>>;

const strings: Strings = {
    'zoom.expand.tooltip': {
        en: 'Zoom in to expand',
        ar: 'كبّر لعرض المحتوى',
    },
};

function detectLocale(): Locale {
    if (typeof navigator === 'undefined' || !navigator.language) return 'en';
    const tag = navigator.language.toLowerCase();
    if (tag.startsWith('ar')) return 'ar';
    return 'en';
}

// Resolved once at module load. If we ever want runtime locale switching
// we'd add a setter and a React context; for now a single read matches
// the simplicity level in the spec.
const currentLocale: Locale = detectLocale();

export function t(key: keyof typeof strings): string {
    const entry = strings[key];
    if (!entry) return key;
    return entry[currentLocale] ?? entry.en ?? key;
}

export function getLocale(): Locale {
    return currentLocale;
}
