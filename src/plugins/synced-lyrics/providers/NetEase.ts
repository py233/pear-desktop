// Adapted from https://github.com/GreasyFork/scripts/blob/master/scripts/548724-youtube-music-spotify-%E7%BD%91%E6%98%93%E4%BA%91%E6%AD%8C%E8%AF%8D%E6%98%BE%E7%A4%BA/code.user.js
// MIT licensed.
import CryptoJS from 'crypto-js';
import { jaroWinkler } from '@skyra/jaro-winkler';
import { z } from 'zod';

import { LRC } from '../parsers/lrc';
import { netFetch } from '../renderer';

import type { LyricProvider, LyricResult, SearchSongInfo } from '../types';

const EAPI_AES_KEY = 'e82ckenh8dichen8';
const EAPI_ENCODE_KEY = '3go8&$8*3*3h0k(2)2';
const EAPI_CHECK_TOKEN =
  '9ca17ae2e6ffcda170e2e6ee8ad85dba908ca4d74da9ac8ea2d44e938f9eadc66da5a8979af572a5a9b68ac12af0feaec3b92aa69af9b1d372f6b8adccb35e968b9bb6c14f908d0099fb6ff48efdacd361f5b6ee9e';
const EAPI_BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/3.0.14.2534',
};
const EAPI_BASE_COOKIES = {
  os: 'osx',
  appver: '3.0.14',
  requestId: 0,
  osver: '15.6.1',
};

const artistSchema = z.object({
  id: z.coerce.number().optional(),
  name: z.string(),
});
const songSchema = z.object({
  resourceId: z.coerce.number(),
  baseInfo: z.object({
    simpleSongData: z.object({
      name: z.string(),
      ar: z.array(artistSchema).optional(),
      dt: z.number(),
    }),
  }),
});
const simpleSongSchema = z.object({
  id: z.coerce.number().optional(),
  resourceId: z.coerce.number().optional(),
  name: z.string(),
  ar: z.array(artistSchema).optional(),
  artists: z.array(artistSchema).optional(),
  dt: z.number().optional(),
  duration: z.number().optional(),
});
const searchResponseSchema = z.object({
  code: z.coerce.number().optional(),
  message: z.unknown().optional(),
  data: z.object({ resources: z.array(z.unknown()).default([]) }).optional(),
  result: z.object({ songs: z.array(z.unknown()).default([]) }).optional(),
});
type Song = z.infer<typeof songSchema>;
type SearchCandidate = {
  title: string;
  weight: number;
  withArtist: boolean;
};

const lyricPartSchema = z.object({ lyric: z.string().nullable().optional() });
const lyricResponseSchema = z.object({
  lrc: lyricPartSchema.optional(),
  tlyric: lyricPartSchema.optional(),
  romalrc: lyricPartSchema.optional(),
});

const JAPANESE_OR_CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;
const LATIN_RE = /[a-z]/i;
const INFO_NOISE_RE =
  /\b(?:official|music\s*video|mv|pv|lyric\s*video|lyrics?|audio|visualizer|full\s*ver\.?|short\s*ver\.?)\b/gi;
const JAPANESE_INFO_NOISE_RE =
  /(?:公式|オフィシャル|ミュージックビデオ|歌詞付き|字幕|中文字幕|中日字幕|ＭＶ|ＰＶ)/g;
const VOCAL_ARTIST_FRAGMENT_RE =
  /(?:初音ミク|鏡音|巡音|音街ウナ|重音テト|可不|星界|裏命|狐子|羽累|花隈千冬|ナースロボ|タイプT|ずんだもん|KAITO|MEIKO|GUMI|IA|ONE|flower|vflower|CeVIO|VOCALOID|UTAU|SynthV|VOICEVOX|VOICEROID)/i;
const FEAT_BLOCK_RE =
  /[\s\u3000]*[([{（【［][^)\]}】］）]*(?:feat|ft|featuring)\.?\s+[^)\]}】］）]*[)\]}】］）]/gi;
const FEAT_TAIL_RE = /(?:^|[\s\u3000(（[])(?:feat|ft|featuring)\.?\s+.+$/i;
const TITLE_DELIMITER_RE = /\s+[-–—]\s+|\s+[/|]\s+|[／｜│]|\s+:\s+|[：]/;

const normalizeLoose = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[＿_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const compact = (value: string) =>
  normalizeLoose(value).replace(/[^\p{L}\p{N}]+/gu, '');

const hasJapaneseOrCjk = (value: string) => JAPANESE_OR_CJK_RE.test(value);

const isLikelyArtistFragment = (value: string) =>
  VOCAL_ARTIST_FRAGMENT_RE.test(value);

const similarity = (left: string, right: string) => {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    return 0.94;
  }
  return jaroWinkler(a, b);
};

const uniqByCompact = <T extends string>(values: T[]): T[] => {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    const key = compact(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
};

const stripNoise = (value: string) =>
  value
    .replace(FEAT_BLOCK_RE, ' ')
    .replace(
      /【[^】]*(?:official|music\s*video|mv|pv|lyric|audio)[^】]*】/gi,
      ' ',
    )
    .replace(
      /\[[^\]]*(?:official|music\s*video|mv|pv|lyric|audio)[^\]]*\]/gi,
      ' ',
    )
    .replace(
      /（[^）]*(?:official|music\s*video|mv|pv|lyric|audio)[^）]*）/gi,
      ' ',
    )
    .replace(
      /\([^)]*(?:official|music\s*video|mv|pv|lyric|audio)[^)]*\)/gi,
      ' ',
    )
    .replace(JAPANESE_INFO_NOISE_RE, ' ')
    .replace(INFO_NOISE_RE, ' ')
    .replace(FEAT_TAIL_RE, ' ')
    .replace(/[([{（【［]\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const parseSong = (raw: unknown): Song | null => {
  const rich = songSchema.safeParse(raw);
  if (rich.success) return rich.data;

  const simple = simpleSongSchema.safeParse(raw);
  if (!simple.success) return null;

  const id = simple.data.resourceId ?? simple.data.id;
  const duration = simple.data.dt ?? simple.data.duration;
  if (!id || !duration) return null;

  return {
    resourceId: id,
    baseInfo: {
      simpleSongData: {
        name: simple.data.name,
        ar: simple.data.ar ?? simple.data.artists ?? [],
        dt: duration,
      },
    },
  };
};

export class NetEase implements LyricProvider {
  name = 'NetEase';
  baseUrl = 'https://interface.music.163.com';
  private cookies: Record<string, string> = {};
  private initialized = false;

  private encode(id: string): string {
    let xoredString = '';
    for (let i = 0; i < id.length; i++) {
      const charCode =
        id.charCodeAt(i) ^
        EAPI_ENCODE_KEY.charCodeAt(i % EAPI_ENCODE_KEY.length);
      xoredString += String.fromCharCode(charCode);
    }

    const hash = CryptoJS.MD5(CryptoJS.enc.Latin1.parse(xoredString)).toString(
      CryptoJS.enc.Base64,
    );
    const combinedWordArray = CryptoJS.enc.Latin1.parse(`${id} ${hash}`);

    return CryptoJS.enc.Base64.stringify(combinedWordArray);
  }

  private async register() {
    const deviceId = '7B79802670C7A45DB9091976D71E0AE829E28926C6C34A1B8644';
    const username = this.encode(deviceId);
    await this.eapi('/register/anonimous', { username }, { _nmclfl: '1' });
    this.initialized = true;
  }

  private async eapi(
    path: string,
    data: Record<string, unknown> = {},
    params: Record<string, string> = {},
  ) {
    const bodyData = {
      ...data,
      header: JSON.stringify(EAPI_BASE_COOKIES),
    };
    const body = JSON.stringify(bodyData);
    const sign = CryptoJS.MD5(
      `nobody/api${path}use${body}md5forencrypt`,
    ).toString();
    const payload = `/api${path}-36cd479b6b5-${body}-36cd479b6b5-${sign}`;
    const key = CryptoJS.enc.Utf8.parse(EAPI_AES_KEY);
    const encrypted = CryptoJS.AES.encrypt(payload, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    }).ciphertext.toString(CryptoJS.enc.Hex);

    const cookieString = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const queryStr = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/eapi${path}${queryStr ? `?${queryStr}` : ''}`;

    const [status, text, headers] = await netFetch(url, {
      method: 'POST',
      headers: {
        ...EAPI_BASE_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
      },
      body: `params=${encodeURIComponent(encrypted.toUpperCase())}`,
    });

    const setCookieHeader = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === 'set-cookie',
    )?.[1];
    if (setCookieHeader) {
      const cookieStrings = setCookieHeader.split(/,(?=\s*[^=;\s]+=)/);
      for (const cookieStr of cookieStrings) {
        const [name, value] = cookieStr.split(';')[0].split('=');
        if (name && value) {
          this.cookies[name.trim()] = value.trim();
        }
      }
    }

    if (status < 200 || status >= 300) {
      throw new Error(`bad HTTPStatus(${status})`);
    }

    const json = JSON.parse(text);
    const code = z
      .object({ code: z.coerce.number().optional() })
      .safeParse(json);
    if (code.success && code.data.code && code.data.code !== 200) {
      throw new Error(`bad APIStatus(${code.data.code})`);
    }

    return json;
  }

  private async searchSongs(keyword: string, limit = 10): Promise<Song[]> {
    try {
      const response = await this.eapi(
        '/search/song/list/page',
        {
          offset: '0',
          scene: 'NORMAL',
          needCorrect: 'true',
          checkToken: EAPI_CHECK_TOKEN,
          keyword,
          limit: limit.toString(),
          verifyId: 1,
        },
        { _nmclfl: '1' },
      );
      const parsed = searchResponseSchema.safeParse(response);
      if (!parsed.success) {
        console.debug('[synced-lyrics] NetEase search response ignored', {
          keyword,
          error: parsed.error.message,
        });
        return [];
      }

      return [
        ...(parsed.data.data?.resources ?? []),
        ...(parsed.data.result?.songs ?? []),
      ]
        .map(parseSong)
        .filter((song): song is Song => Boolean(song));
    } catch (error) {
      console.debug('[synced-lyrics] NetEase search failed', {
        keyword,
        error,
      });
      return [];
    }
  }

  private async getLyric(id: number) {
    const response = await this.eapi(
      '/song/lyric/v1',
      {
        id,
        tv: '-1',
        yv: '-1',
        rv: '-1',
        lv: '-1',
        verifyId: 1,
      },
      { _nmclfl: '1' },
    );
    const parsed = lyricResponseSchema.safeParse(response);
    return parsed.success ? parsed.data : null;
  }

  private splitArtistNames(...values: (string | undefined)[]): string[] {
    return uniqByCompact(
      values
        .flatMap((value) =>
          (value ?? '')
            .split(/\s*(?:[&,、，/／|｜;；]|\band\b|\bfeat\.?\b|\bft\.?\b)\s*/i)
            .map(stripNoise),
        )
        .filter(Boolean),
    );
  }

  private isArtistLike(fragment: string, artistNames: string[]): boolean {
    const key = compact(fragment);
    if (!key) return true;
    if (isLikelyArtistFragment(fragment)) return true;

    return artistNames.some((artist) => {
      const artistKey = compact(artist);
      if (!artistKey) return false;
      return (
        key === artistKey ||
        (key.length >= 3 && artistKey.includes(key)) ||
        (artistKey.length >= 3 && key.includes(artistKey)) ||
        similarity(fragment, artist) >= 0.9
      );
    });
  }

  private splitTitle(title: string, artistNames: string[]): string[] {
    const cleaned = stripNoise(title);
    if (!cleaned) return [];
    const hasDelimiter = TITLE_DELIMITER_RE.test(cleaned);

    const quoted = Array.from(
      cleaned.matchAll(/[「『](?<content>.+?)[」』]/g),
      ({ groups }) => stripNoise(groups?.content ?? ''),
    );
    const fragments = cleaned
      .replace(/[「『](.+?)[」』]/g, '$1')
      .split(TITLE_DELIMITER_RE)
      .map(stripNoise)
      .filter(Boolean);
    const parts = hasDelimiter
      ? [...quoted, ...fragments]
      : [cleaned, ...quoted, ...fragments];

    return uniqByCompact(
      parts.filter(
        (part) =>
          part &&
          compact(part).length > 1 &&
          !/\b(?:official|music\s*video|mv|pv|lyric|audio)\b/i.test(part) &&
          !this.isArtistLike(part, artistNames),
      ),
    );
  }

  private buildTitleCandidates(
    title: string,
    alternativeTitle: string,
    artistNames: string[],
  ): SearchCandidate[] {
    const sourceTitles = uniqByCompact(
      [title, alternativeTitle].filter(Boolean),
    );
    const candidates: SearchCandidate[] = [];
    const add = (candidateTitle: string, weight: number, withArtist = true) => {
      const cleaned = stripNoise(candidateTitle);
      if (!cleaned || this.isArtistLike(cleaned, artistNames)) return;
      candidates.push({ title: cleaned, weight, withArtist });
    };

    for (const sourceTitle of sourceTitles) {
      const sourceLooksSplit = TITLE_DELIMITER_RE.test(stripNoise(sourceTitle));
      add(sourceTitle, sourceLooksSplit ? 0.62 : 0.88, false);

      const parts = this.splitTitle(sourceTitle, artistNames);
      for (const [idx, part] of parts.entries()) {
        const hasCjk = hasJapaneseOrCjk(part);
        const weight =
          idx === 0 ? (hasCjk ? 1.28 : 1.12) : hasCjk ? 0.96 : 0.78;
        add(part, weight);
      }
    }

    return candidates
      .sort((a, b) => b.weight - a.weight)
      .filter((candidate, idx, arr) => {
        const key = compact(candidate.title);
        return arr.findIndex((item) => compact(item.title) === key) === idx;
      })
      .slice(0, 8);
  }

  private buildSearchKeywords(
    candidates: SearchCandidate[],
    artistNames: string[],
  ) {
    const keywords: string[] = [];
    for (const candidate of candidates) {
      keywords.push(candidate.title);
      if (!candidate.withArtist) continue;
      for (const artist of artistNames.slice(0, 2)) {
        keywords.push(`${candidate.title} ${artist}`);
      }
    }

    return uniqByCompact(keywords).slice(0, 16);
  }

  private scoreTitle(candidateTitle: string, candidates: SearchCandidate[]) {
    let best = { score: 0, title: '' };
    for (const candidate of candidates) {
      const score = Math.min(
        1,
        similarity(candidate.title, candidateTitle) * candidate.weight,
      );
      if (score > best.score) {
        best = { score, title: candidate.title };
      }
    }
    return best;
  }

  private scoreArtist(itemArtists: string[], artistNames: string[]) {
    let best = 0;
    for (const left of itemArtists) {
      for (const right of artistNames) {
        best = Math.max(best, similarity(left, right));
      }
    }
    return best;
  }

  async search({
    title,
    alternativeTitle,
    artist,
    songDuration,
    tags,
  }: SearchSongInfo): Promise<LyricResult | null> {
    try {
      if (!this.initialized) {
        await this.register();
      }

      const artistNames = this.splitArtistNames(artist, ...(tags ?? []));
      const candidates = this.buildTitleCandidates(
        title,
        alternativeTitle || '',
        artistNames,
      );
      if (candidates.length === 0) return null;

      const keywords = this.buildSearchKeywords(candidates, artistNames);
      const hasComparableDuration =
        Number.isFinite(songDuration) && songDuration > 0;
      const results = await Promise.all(
        keywords.map((keyword) => this.searchSongs(keyword, 10)),
      );

      const uniqueResults = new Map<number, Song>();
      for (const result of results.flat()) {
        uniqueResults.set(result.resourceId, result);
      }

      const rankedResults = Array.from(uniqueResults.values())
        .map((result) => {
          const song = result.baseInfo.simpleSongData;
          const itemArtists = song.ar?.map((item) => item.name) ?? [];
          const normalizedSongTitle = stripNoise(song.name) || song.name;
          const titleMatch = this.scoreTitle(normalizedSongTitle, candidates);
          const artistScore = this.scoreArtist(itemArtists, artistNames);
          const duration = song.dt / 1000;
          const durationDelta = hasComparableDuration
            ? Math.abs(duration - songDuration)
            : 0;
          const durationPenalty = hasComparableDuration
            ? durationDelta / 25
            : 0;
          const durationScore = hasComparableDuration
            ? Math.max(0, 1 - durationPenalty)
            : 0.2;
          const titleWeightedScore = titleMatch.score * 1.65;
          const artistWeightedScore = artistScore * 0.7;
          const durationWeightedScore = durationScore * 0.4;
          const ambiguousLatinTitle =
            compact(titleMatch.title).length <= 6 &&
            LATIN_RE.test(titleMatch.title) &&
            !hasJapaneseOrCjk(titleMatch.title);
          const latinOnlyTitle =
            LATIN_RE.test(titleMatch.title) &&
            !hasJapaneseOrCjk(titleMatch.title);

          return {
            result,
            title: song.name,
            titleScore: titleMatch.score,
            artistScore,
            durationDelta,
            score:
              titleWeightedScore + artistWeightedScore + durationWeightedScore,
            ambiguousLatinTitle,
            latinOnlyTitle,
          };
        })
        .filter((item) => {
          if (item.titleScore < 0.72) return false;
          if (hasComparableDuration && item.durationDelta > 25) return false;
          if (
            hasComparableDuration &&
            item.durationDelta > 15 &&
            item.titleScore < 0.9
          ) {
            return false;
          }
          if (item.artistScore < 0.35 && item.titleScore < 0.92) return false;
          if (
            item.latinOnlyTitle &&
            artistNames.length > 0 &&
            item.artistScore < 0.35
          ) {
            return false;
          }
          if (item.ambiguousLatinTitle && item.artistScore < 0.55) {
            return false;
          }
          return item.score >= 1.65;
        })
        .sort((a, b) => {
          if (Math.abs(b.score - a.score) > 0.08) {
            return b.score - a.score;
          }
          return a.durationDelta - b.durationDelta;
        });

      const closestResult = rankedResults[0]?.result;
      if (!closestResult) {
        if (candidates.length) {
          console.debug('[synced-lyrics] NetEase no match', {
            title,
            artist,
            candidates: candidates.map((candidate) => candidate.title),
          });
        }
        return null;
      }

      const lyric = await this.getLyric(closestResult.resourceId);
      const lyrics = stripMetadata(lyric?.lrc?.lyric ?? '').trim();
      if (!lyrics) return null;

      const lines = LRC.parse(lyrics).lines.map((line) => ({
        ...line,
        status: 'upcoming' as const,
      }));
      const translatedLyrics = stripMetadata(lyric?.tlyric?.lyric ?? '').trim();
      const translatedLines = translatedLyrics
        ? LRC.parse(translatedLyrics).lines.map((line) => ({
            ...line,
            status: 'upcoming' as const,
          }))
        : undefined;

      return {
        title: closestResult.baseInfo.simpleSongData.name,
        artists:
          closestResult.baseInfo.simpleSongData.ar?.map((item) => item.name) ??
          [],
        lines,
        lyrics,
        translation: translatedLyrics
          ? {
              lyrics: translatedLyrics,
              lines: translatedLines?.length ? translatedLines : undefined,
              language: 'zh-CN',
              provider: this.name,
            }
          : undefined,
      };
    } catch (error) {
      console.debug('[synced-lyrics] NetEase search ignored', {
        title,
        artist,
        error,
      });
      return null;
    }
  }
}

const stripMetadata = (lyrics: string) => {
  return lyrics
    .split('\n')
    .filter((line) => {
      if (!line.includes('{')) return true;
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    })
    .join('\n');
};
