export interface Translations {
  lang: string;

  t: { [key: string]: string };
}

const DEFAULT_LANG: string = import.meta.env.PUBLIC_DEFAULT_LANGUAGE;

import de from './de/index.json';
import en from './en/index.json';

export const languages = {
  en: 'English',
  de: 'Deutsch',
};

export const defaultLang = (DEFAULT_LANG || 'en') as keyof typeof languages;

const labels = { de, en };

const defaultLabels = labels[defaultLang];

export const getLangFromUrl = (url: URL) => {
  const [, lang] = url.pathname.split('/');
  if (lang in labels) return lang as keyof typeof labels;
  return defaultLang;
};

export const getTranslations = (
  url: string,
  dictionary: keyof typeof defaultLabels
): Translations => {
  const lang = getLangFromUrl(new URL(url));

  return {
    lang,
    t: {
      ...defaultLabels[dictionary],
      ...labels[lang][dictionary],
    },
  };
};

export const getDefaultTranslations = (
  dictionary: keyof typeof defaultLabels
): Translations => {
  const lang = defaultLang;

  return {
    lang,
    t: {
      ...defaultLabels[dictionary],
      ...labels[lang][dictionary],
    },
  };
};
