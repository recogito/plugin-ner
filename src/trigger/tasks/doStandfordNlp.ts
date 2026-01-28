import { task, logger } from '@trigger.dev/sdk/v3';
import type { NERResults, TagTypes } from '../types';
import { off } from 'process';

/*
DATE, TIME, DURATION, SET, MONEY, NUMBER, ORDINAL, PERCENT, PERSON, LOCATION, ORGANIZATION, MISC, CAUSE_OF_DEATH, CITY, COUNTRY, CRIMINAL_CHARGE, EMAIL, IDEOLOGY, NATIONALITY, RELIGION, STATE_OR_PROVINCE, TITLE, URL
*/
export interface Root {
  sentences: Sentence[];
}

export interface Sentence {
  index: number;
  entitymentions: Entitymention[];
  tokens: Token[];
}

export interface Entitymention {
  docTokenBegin: number;
  docTokenEnd: number;
  tokenBegin: number;
  tokenEnd: number;
  text: string;
  characterOffsetBegin: number;
  characterOffsetEnd: number;
  ner: string;
  nerConfidences?: NerConfidences;
  normalizedNER?: string;
  timex?: Timex;
}

export interface NerConfidences {
  PERSON?: number;
  ORGANIZATION?: number;
  DATE?: number;
  LOCATION?: number;
  DURATION?: number;
  MISC?: number;
  ORDINAL?: number;
  NUMBER?: number;
  SET?: number;
  TIME?: number;
  MONEY?: number;
}

export interface Timex {
  tid: string;
  type: string;
  value?: string;
  altValue?: string;
}

export interface Token {
  index: number;
  word: string;
  originalText: string;
  lemma: string;
  characterOffsetBegin: number;
  characterOffsetEnd: number;
  pos: string;
  ner: string;
  before: string;
  after: string;
  normalizedNER?: string;
  timex?: Timex2;
}

export interface Timex2 {
  tid: string;
  type: string;
  value?: string;
  altValue?: string;
}

const entityMapping: {
  [key: string]: {
    tag: TagTypes;
    attributes?: { [key: string]: string };
    localized: { en: string; de: string };
  };
} = {
  PERSON: {
    tag: 'persName',
    localized: {
      en: 'Person',
      de: 'Person',
    },
  },
  ORGANIZATION: {
    tag: 'orgName',
    localized: {
      en: 'Organization',
      de: 'Organisation',
    },
  },
  LOCATION: {
    tag: 'placeName',
    localized: {
      en: 'Location',
      de: 'Standort',
    },
  },
  CITY: {
    tag: 'settlement',
    attributes: { type: 'city' },
    localized: {
      en: 'City',
      de: 'Stadt',
    },
  },
  COUNTRY: {
    tag: 'country',
    localized: {
      en: 'Country',
      de: 'Land',
    },
  },
  STATE_OR_PROVINCE: {
    tag: 'region',
    localized: {
      en: 'Province',
      de: 'Provinz',
    },
  },
  DATE: {
    tag: 'date',
    localized: {
      en: 'Date',
      de: 'Datum',
    },
  },
};

const CoreNLPUrlEN =
  process?.env.CORENLP_URL_EN ||
  import.meta.env?.CORENLP_URL_EN ||
  'http://localhost:9000';

const CoreNLPUrlDE =
  process?.env.CORENLP_URL_DE ||
  import.meta.env?.CORENLP_URL_DE ||
  'http://localhost:9000';

const MAX_LENGTH = 5000;

export const doStanfordNlp = task({
  id: 'do-nlp-ner',
  run: async (
    payload: {
      data: string;
      language: 'en' | 'de';
      outputLanguage: 'en' | 'de';
    },
    { ctx }
  ) => {
    const { data, language, outputLanguage } = payload;

    const smartChunk = (str: string) => {
      const chunks = [];
      const iters = Math.ceil(str.length / MAX_LENGTH);

      // We need to be sure we break up strings on spaces
      let offset = 0;
      for (let i = 0; i < iters; i++) {
        let chunk = str.substring(offset, offset + MAX_LENGTH);

        // Find the next space
        const idx = str.indexOf(' ', offset + MAX_LENGTH);

        if (idx === -1 && i === iters - 1) {
          chunks.push(chunk);
        } else {
          chunks.push(str.substring(offset, idx));
          offset = idx + 1;
        }
      }

      return chunks;
    };

    const url = language === 'en' ? CoreNLPUrlEN : CoreNLPUrlDE;
    const params = new URLSearchParams({
      properties: JSON.stringify({
        annotators: 'ner',
        outputFormat: 'json',
      }),
    });

    const chunks = smartChunk(data);

    let offset = 0;
    let ret: NERResults = { entries: [] };

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      logger.info(`Sending part ${i + 1} of ${chunks.length}`);
      const resp = await fetch(`${url}/?${params}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
        },
        body: chunk,
      });

      if (resp.ok) {
        const out: Root = await resp.json();

        for (let i = 0; i < out.sentences.length; i++) {
          const sentence = out.sentences[i];

          for (let j = 0; j < sentence.entitymentions.length; j++) {
            const mention = sentence.entitymentions[j];
            const map = entityMapping[mention.ner];
            if (map) {
              ret.entries.push({
                text: mention.text,
                startIndex: mention.characterOffsetBegin + offset,
                endIndex: mention.characterOffsetEnd + offset,
                localizedTag: map.localized[outputLanguage],
                inlineTag: map.tag,
                attributes: map.attributes,
              });
            }
          }
        }

        offset += chunk.length + 1; // Account for the last space
      } else {
        logger.error(resp.statusText);
        throw new Error(resp.statusText);
      }
    }

    return { ner: ret };
  },
});
