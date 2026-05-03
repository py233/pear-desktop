import { translate } from '@vitalets/google-translate-api';

import { isSkippableLine } from '../prompt';

import type { TranslationProvider } from '../types';

type IndexedLine = { index: number; text: string };

const translatableLines = (lines: string[]): IndexedLine[] =>
  lines
    .map((text, index) => ({ index, text }))
    .filter(({ text }) => text.trim() && !isSkippableLine(text));

const mergeTranslatedLines = (
  sourceLines: string[],
  indexed: IndexedLine[],
  translated: string[],
): string[] => {
  const output = sourceLines.map((line) => (isSkippableLine(line) ? line : ''));
  for (const [idx, item] of indexed.entries()) {
    output[item.index] = translated[idx] ?? '';
  }
  return output;
};

const googleTargetLanguage = (language: string): string => {
  if (language.toLowerCase() === 'fil') return 'tl';
  return language;
};

const splitTranslatedText = (text: string, expectedLength: number) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return lines.length === expectedLength ? lines : null;
};

const markerFor = (index: number) =>
  `<<<YTMD_LYRICS_LINE_${String(index).padStart(4, '0')}>>>`;

const splitByMarkers = (text: string, expectedLength: number) => {
  const pattern = /<<<\s*YTMD_LYRICS_LINE_(\d{4})\s*>>>/g;
  const matches = Array.from(text.matchAll(pattern));
  if (matches.length !== expectedLength - 1) return null;

  const output: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? -1;
    if (index < cursor) return null;
    output.push(text.slice(cursor, index).trim());
    cursor = index + match[0].length;
  }
  output.push(text.slice(cursor).trim());

  return output.length === expectedLength ? output : null;
};

export const googleTranslateProvider: TranslationProvider = {
  name: 'google-translate',
  async translate(req, settings) {
    const { host = 'translate.google.com' } = settings as { host?: string };
    const target = googleTargetLanguage(req.resolvedTargetLanguage);
    const indexed = translatableLines(req.lines);
    if (indexed.length === 0) return mergeTranslatedLines(req.lines, [], []);

    const joined = indexed.map((line) => line.text).join('\n');
    const joinedResult = await translate(joined, { to: target, host }).then(
      (res) => splitTranslatedText(res.text, indexed.length),
      () => null,
    );
    if (joinedResult) {
      return mergeTranslatedLines(req.lines, indexed, joinedResult);
    }

    const marked = indexed
      .map((line, index) =>
        index === 0 ? line.text : `${markerFor(index)}\n${line.text}`,
      )
      .join('\n');
    const markedResult = await translate(marked, { to: target, host }).then(
      (res) => splitByMarkers(res.text, indexed.length),
      () => null,
    );
    if (markedResult) {
      return mergeTranslatedLines(req.lines, indexed, markedResult);
    }

    throw new Error(
      'Google Translate did not preserve lyric line breaks; refusing per-line fallback to avoid rate limits',
    );
  },
};
