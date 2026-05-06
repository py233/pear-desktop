// Adapted from https://github.com/GreasyFork/scripts/blob/master/scripts/548724-youtube-music-spotify-%E7%BD%91%E6%98%93%E4%BA%91%E6%AD%8C%E8%AF%8D%E6%98%BE%E7%A4%BA/code.user.js
// MIT licensed.
import CryptoJS from 'crypto-js';
import { z } from 'zod';

import { LRC } from '../parsers/lrc';
import { netFetch } from '../renderer';
import { translationDebug } from '../renderer/debug';
import { config } from '../renderer/renderer';

import type {
  LineLyrics,
  LyricProvider,
  LyricResult,
  SearchSongInfo,
} from '../types';

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
type RankedSong = {
  result: Song;
  title: string;
  titleScore: number;
  artistScore: number;
  durationDelta: number;
  score: number;
  ambiguousLatinTitle: boolean;
  latinOnlyTitle: boolean;
};
type CandidateMatch = RankedSong & { strict: boolean };
type SearchSongsResult = {
  keyword: string;
  rawCount: number;
  songs: Song[];
  error: Error | null;
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
  /(?:初音ミク|Hatsune\s*Miku|鏡音|Kagamine|巡音|Megurine|音街ウナ|Otomachi\s*Una|重音テト|Kasane\s*Teto|可不|KAFU|星界|SEKAI|裏命|RIME|狐子|COKO|羽累|HARU|花隈千冬|Hanakuma\s*Chifuyu|ナースロボ|Nurse\s*Robot|タイプT|Type\s*T|ずんだもん|Zundamon|KAITO|MEIKO|GUMI|IA|ONE|flower|vflower|CeVIO|VOCALOID|UTAU|SynthV|VOICEVOX|VOICEROID)/i;
const FEAT_BLOCK_RE =
  /[\s\u3000]*[([{（【［][^)\]}】］）]*(?:feat|ft|featuring)\.?\s+[^)\]}】］）]*[)\]}】］）]/gi;
const FEAT_TAIL_RE = /(?:^|[\s\u3000(（[])(?:feat|ft|featuring)\.?\s+.+$/i;
const FEATURED_ARTIST_BLOCK_RE =
  /[([{（【［][^)\]}】］）]*(?:feat|ft|featuring)\.?\s+([^)\]}】］）]+)[)\]}】］）]/gi;
const FEATURED_ARTIST_TAIL_RE =
  /(?:^|[\s\u3000(（[])(?:feat|ft|featuring)\.?\s+(.+)$/i;
const TITLE_DELIMITER_RE = /\s+[-–—]\s+|\s+[/|]\s+|[／｜│]|\s+:\s+|[：]/;
const BRACKET_BLOCK_RE = /[([{（【［]([^)\]}】］）]+)[)\]}】］）]/g;
const NETEASE_CREDIT_LINE_RE =
  /^(?:作词|作詞|作曲|编曲|編曲|制作人|和声|和聲|混音|母带|母帶|录音|錄音|吉他|贝斯|貝斯|鼓|钢琴|鋼琴|键盘|鍵盤|Lyricist|Composer|Arranger|Producer|Mixing|Mastering|Vocal|Guitar|Bass|Drums)\s*[:：]/i;
const JAPANESE_KANA_RE = /[\u3040-\u30ff]/;
const HANGUL_RE = /[\uac00-\ud7af]/;
const THAI_RE = /[\u0e00-\u0e7f]/;
const BENGALI_RE = /[\u0980-\u09ff]/;
const DEVANAGARI_RE = /[\u0900-\u097f]/;

const normalizeLoose = (value: string) =>
  value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[＿_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const compact = (value: string) =>
  normalizeLoose(value).replace(/[^\p{L}\p{N}]+/gu, '');

const debugNetEase = (message: string, data?: unknown) => {
  translationDebug(`NetEase ${message}`, data);
};

const toError = (error: unknown, fallbackMessage: string) => {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.trim()) return new Error(error);
  return new Error(fallbackMessage);
};

const searchTextKey = (value: string) => normalizeLoose(value);

const stripSearchPunctuation = (value: string) =>
  value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasJapaneseOrCjk = (value: string) => JAPANESE_OR_CJK_RE.test(value);

const hasNonLatinRomanizableText = (value: string) =>
  JAPANESE_KANA_RE.test(value) ||
  HANGUL_RE.test(value) ||
  THAI_RE.test(value) ||
  BENGALI_RE.test(value) ||
  DEVANAGARI_RE.test(value);

const isLikelyArtistFragment = (value: string) =>
  VOCAL_ARTIST_FRAGMENT_RE.test(value);

const levenshteinDistance = (left: string, right: string) => {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }

    [previous, current] = [current, previous];
  }

  return previous[b.length] ?? 0;
};

const editSimilarity = (left: string, right: string) => {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const distanceRatio =
    levenshteinDistance(a, b) / Math.max(a.length, b.length);
  return Math.max(0, 1 - distanceRatio);
};

const similarity = (left: string, right: string) => {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    return 0.94;
  }

  return editSimilarity(left, right);
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

const uniqBySearchText = <T extends string>(values: T[]): T[] => {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    const key = searchTextKey(value);
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

  private async searchSongs(
    keyword: string,
    limit = 10,
  ): Promise<SearchSongsResult> {
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
        throw new Error(
          `NetEase search response schema mismatch: ${parsed.error.message}`,
        );
      }

      const rawItems = [
        ...(parsed.data.data?.resources ?? []),
        ...(parsed.data.result?.songs ?? []),
      ];
      const songs = rawItems
        .map(parseSong)
        .filter((song): song is Song => Boolean(song));
      debugNetEase('keyword result', {
        keyword,
        rawCount: rawItems.length,
        parsedCount: songs.length,
        first: songs.slice(0, 5).map((song) => ({
          id: song.resourceId,
          title: song.baseInfo.simpleSongData.name,
          artists:
            song.baseInfo.simpleSongData.ar?.map((item) => item.name) ?? [],
          duration: Math.round(song.baseInfo.simpleSongData.dt / 1000),
        })),
      });

      return { keyword, rawCount: rawItems.length, songs, error: null };
    } catch (error) {
      const normalizedError = toError(error, 'Unknown NetEase search error');
      debugNetEase('keyword failed', {
        keyword,
        message: normalizedError.message,
        stack: normalizedError.stack,
      });
      return { keyword, rawCount: 0, songs: [], error: normalizedError };
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

  private filterArtistTagValues(
    title: string,
    alternativeTitle: string,
    album: string | null | undefined,
    artist: string,
    tags: string[] = [],
  ) {
    const primaryArtistNames = this.splitArtistNames(artist);
    const songTitleValues = [title, alternativeTitle].filter(Boolean);
    const albumTitleValue =
      album && songTitleValues.some((value) => similarity(album, value) >= 0.92)
        ? album
        : '';
    const titleKeys = uniqByCompact(
      [...songTitleValues, albumTitleValue]
        .flatMap((value) => [value, stripNoise(value)])
        .filter(Boolean),
    ).map(compact);
    const ignored: string[] = [];
    const titleTags: string[] = [];
    let seenTitleTag = false;
    const artistTags = tags.filter((tag) => {
      const tagKeys = [tag, stripNoise(tag)].map(compact).filter(Boolean);
      const titleLike = tagKeys.some((tagKey) =>
        titleKeys.some((titleKey) => tagKey === titleKey),
      );
      const localizedTitleLike =
        seenTitleTag &&
        hasNonLatinRomanizableText(tag) &&
        !this.isArtistLike(tag, primaryArtistNames) &&
        !isLikelyArtistFragment(tag);
      if (titleLike || localizedTitleLike) {
        ignored.push(tag);
        titleTags.push(tag);
        seenTitleTag ||= titleLike;
        return false;
      }

      return true;
    });

    return { artistTags, titleTags: uniqByCompact(titleTags), ignored };
  }

  private featuredArtistNamesFromTitles(
    ...titles: (string | undefined)[]
  ): string[] {
    const featured: string[] = [];
    for (const title of titles) {
      if (!title) continue;

      for (const match of title.matchAll(FEATURED_ARTIST_BLOCK_RE)) {
        if (match[1]) featured.push(match[1]);
      }

      const tail = title.match(FEATURED_ARTIST_TAIL_RE)?.[1];
      if (tail) featured.push(tail);
    }

    return this.splitArtistNames(...featured);
  }

  private buildSearchArtistNames(
    artistNames: string[],
    featuredArtistNames: string[],
  ) {
    const primaryArtists = artistNames.slice(0, 2);
    const aliases = primaryArtists.flatMap((artistName) => {
      const withoutPunctuation = stripSearchPunctuation(artistName);
      return withoutPunctuation && withoutPunctuation !== artistName
        ? [artistName, withoutPunctuation]
        : [artistName];
    });

    return uniqBySearchText([...aliases, ...featuredArtistNames]).slice(0, 4);
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

  private cleanTitleFragment(fragment: string, artistNames: string[]): string {
    return stripNoise(fragment)
      .replace(BRACKET_BLOCK_RE, (match, content: string) =>
        this.isArtistLike(content, artistNames) ? ' ' : match,
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  private splitTitle(title: string, artistNames: string[]): string[] {
    const cleaned = this.cleanTitleFragment(title, artistNames);
    if (!cleaned) return [];
    const hasDelimiter = TITLE_DELIMITER_RE.test(cleaned);

    const quoted = Array.from(
      cleaned.matchAll(/[「『](?<content>.+?)[」』]/g),
      ({ groups }) => stripNoise(groups?.content ?? ''),
    );
    const fragments = cleaned
      .replace(/[「『](.+?)[」』]/g, '$1')
      .split(TITLE_DELIMITER_RE)
      .map((part) => this.cleanTitleFragment(part, artistNames))
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
    titleTags: string[] = [],
  ): SearchCandidate[] {
    const sourceTitles = uniqByCompact(
      [title, alternativeTitle, ...titleTags].filter(Boolean),
    );
    const candidates: SearchCandidate[] = [];
    const add = (candidateTitle: string, weight: number, withArtist = true) => {
      const cleaned = this.cleanTitleFragment(candidateTitle, artistNames);
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
    featuredArtistNames: string[] = [],
  ) {
    const keywords: string[] = [];
    const searchArtistNames = this.buildSearchArtistNames(
      artistNames,
      featuredArtistNames,
    );
    for (const candidate of candidates) {
      keywords.push(candidate.title);
      if (!candidate.withArtist) continue;
      for (const artist of searchArtistNames) {
        keywords.push(`${candidate.title} ${artist}`);
      }
    }

    return uniqBySearchText(keywords).slice(0, 16);
  }

  private scoreTitle(
    candidateTitle: string,
    candidates: SearchCandidate[],
    fallbackTitles: string[] = [],
  ) {
    let best = { score: 0, title: '' };
    for (const title of fallbackTitles) {
      if (!title) continue;
      const score = similarity(title, candidateTitle);
      if (score > best.score) {
        best = { score, title };
      }
    }

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
    if (artistNames.length === 0) return 0.5;

    let best = 0;
    for (const left of itemArtists) {
      for (const right of artistNames) {
        best = Math.max(best, similarity(left, right));
      }
    }
    return best;
  }

  private isAllowedStrictMatch(
    item: RankedSong,
    hasComparableDuration: boolean,
    hasArtistNames: boolean,
  ) {
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
    if (item.latinOnlyTitle && hasArtistNames && item.artistScore < 0.35) {
      return false;
    }
    if (item.ambiguousLatinTitle && item.artistScore < 0.55) return false;
    return item.score >= 1.55;
  }

  private isAllowedInexactMatch(
    item: RankedSong,
    hasComparableDuration: boolean,
    hasArtistNames: boolean,
  ) {
    if (!(config()?.showLyricsEvenIfInexact ?? true)) return false;
    if (item.titleScore < 0.62) return false;
    if (hasComparableDuration && item.durationDelta > 45) return false;
    if (item.titleScore < 0.8 && item.artistScore < 0.25) return false;
    if (
      item.latinOnlyTitle &&
      hasArtistNames &&
      item.artistScore < 0.25 &&
      item.titleScore < 0.9
    ) {
      return false;
    }
    if (item.ambiguousLatinTitle && item.artistScore < 0.45) return false;
    return item.score >= 1.25;
  }

  private millisToTime(millis: number) {
    const totalMs = Math.max(0, Math.round(millis));
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const centiseconds = Math.floor((totalMs % 1000) / 10);
    return `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
  }

  private isNetEaseCreditLine(text: string, timeInMs: number) {
    return timeInMs <= 12000 && NETEASE_CREDIT_LINE_RE.test(text.trim());
  }

  private normalizeLineDurations(lines: LineLyrics[]) {
    const sorted = [...lines].sort((a, b) => a.timeInMs - b.timeInMs);
    for (const [index, line] of sorted.entries()) {
      const next = sorted[index + 1];
      line.duration = next
        ? Math.max(0, next.timeInMs - line.timeInMs)
        : Number.isFinite(line.duration)
          ? line.duration
          : 3500;
    }

    const first = sorted[0];
    if (first && first.timeInMs > 300) {
      sorted.unshift({
        time: '00:00.00',
        timeInMs: 0,
        duration: first.timeInMs,
        text: '',
        status: 'upcoming',
      });
    }

    return sorted;
  }

  private parseNetEaseJsonLyrics(lyrics: string): LineLyrics[] {
    if (!lyrics) return [];

    const lines: LineLyrics[] = [];
    for (const rawLine of lyrics.split('\n')) {
      const raw = rawLine.trim();
      if (!raw.startsWith('{')) continue;

      try {
        const parsed = z
          .object({
            t: z.coerce.number(),
            c: z
              .array(z.object({ tx: z.string().nullable().optional() }))
              .default([]),
          })
          .safeParse(JSON.parse(raw));
        if (!parsed.success) continue;

        const timeInMs = parsed.data.t;
        const text = parsed.data.c
          .map((segment) => segment.tx ?? '')
          .join('')
          .trim();
        if (this.isNetEaseCreditLine(text, timeInMs)) continue;

        lines.push({
          time: this.millisToTime(timeInMs),
          timeInMs,
          duration: Infinity,
          text,
          status: 'upcoming',
        });
      } catch {
        // Ignore non-JSON metadata lines.
      }
    }

    return this.normalizeLineDurations(lines);
  }

  private parseNetEaseLyrics(lyrics: string): LineLyrics[] {
    const parsed = LRC.parse(stripMetadata(lyrics))
      .lines.filter(
        (line) => !this.isNetEaseCreditLine(line.text, line.timeInMs),
      )
      .map((line) => ({ ...line, status: 'upcoming' as const }));
    if (parsed.some((line) => line.text.trim())) {
      return this.normalizeLineDurations(parsed);
    }

    return this.parseNetEaseJsonLyrics(lyrics);
  }

  private plainLyricsFromLines(lines: LineLyrics[]) {
    return lines
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join('\n');
  }

  private romanizedTextsFromLyrics(
    romanizedLyrics: string,
    sourceLines: LineLyrics[],
  ) {
    if (!romanizedLyrics || sourceLines.length === 0) return [];

    const romanizedLines = LRC.parse(stripMetadata(romanizedLyrics)).lines;
    if (romanizedLines.length === 0) return [];

    const aligned = sourceLines.map(() => '');
    if (romanizedLines.length === sourceLines.length) {
      return romanizedLines.map((line) => line.text ?? '');
    }

    const used = new Set<number>();
    for (const [sourceIndex, source] of sourceLines.entries()) {
      if (!source.text.trim()) continue;

      let bestIndex = -1;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const [romanIndex, roman] of romanizedLines.entries()) {
        if (used.has(romanIndex) || !roman.text.trim()) continue;
        const delta = Math.abs(roman.timeInMs - source.timeInMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIndex = romanIndex;
        }
      }

      if (bestIndex !== -1 && bestDelta <= 500) {
        aligned[sourceIndex] = romanizedLines[bestIndex].text ?? '';
        used.add(bestIndex);
      }
    }

    return aligned;
  }

  private lineNeedsRomanization(text: string, sourceLooksJapanese: boolean) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (sourceLooksJapanese && JAPANESE_OR_CJK_RE.test(trimmed)) return true;
    return hasNonLatinRomanizableText(trimmed);
  }

  private hasCompleteRomanization(
    sourceLines: LineLyrics[],
    romanizedTexts: string[],
  ) {
    if (romanizedTexts.length !== sourceLines.length) return false;

    const sourceLooksJapanese = sourceLines.some((line) =>
      JAPANESE_KANA_RE.test(line.text),
    );
    let needsRomanization = false;
    for (const [index, line] of sourceLines.entries()) {
      if (!this.lineNeedsRomanization(line.text, sourceLooksJapanese)) {
        continue;
      }

      needsRomanization = true;
      if (!romanizedTexts[index]?.trim()) return false;
    }

    return needsRomanization;
  }

  async search({
    title,
    alternativeTitle,
    artist,
    album,
    songDuration,
    tags,
  }: SearchSongInfo): Promise<LyricResult | null> {
    try {
      if (!this.initialized) {
        await this.register();
      }

      const { artistTags, titleTags, ignored } = this.filterArtistTagValues(
        title,
        alternativeTitle || '',
        album,
        artist,
        tags ?? [],
      );
      const artistNames = this.splitArtistNames(artist, ...artistTags);
      const featuredArtistNames = this.featuredArtistNamesFromTitles(
        title,
        alternativeTitle || '',
      );
      debugNetEase('input', {
        title,
        alternativeTitle,
        artist,
        album,
        songDuration,
        tags: tags ?? [],
        artistTags,
        titleTags,
        ignoredArtistTags: ignored,
        artistNames,
        featuredArtistNames,
        showLyricsEvenIfInexact: config()?.showLyricsEvenIfInexact ?? true,
      });

      const candidates = this.buildTitleCandidates(
        title,
        alternativeTitle || '',
        artistNames,
        titleTags,
      );
      if (candidates.length === 0) {
        debugNetEase('stopped: no title candidates', {
          title,
          alternativeTitle,
          artist,
          artistNames,
        });
        return null;
      }

      const keywords = this.buildSearchKeywords(
        candidates,
        artistNames,
        featuredArtistNames,
      );
      debugNetEase('prepared search', {
        candidates,
        keywords,
      });
      const hasComparableDuration =
        Number.isFinite(songDuration) && songDuration > 0;
      const results = await Promise.all(
        keywords.map((keyword) => this.searchSongs(keyword, 10)),
      );
      const failedResults = results.filter((result) => result.error);
      if (failedResults.length === results.length) {
        const error =
          failedResults[0]?.error ?? new Error('Unknown NetEase search error');
        throw new Error(
          `NetEase search failed for all ${keywords.length} keywords: ${error.message}`,
        );
      }

      if (failedResults.length) {
        debugNetEase('partial search failure', {
          failed: failedResults.map((result) => result.keyword),
          succeeded: results
            .filter((result) => !result.error)
            .map((result) => result.keyword),
        });
      }
      debugNetEase('search summary', {
        keywordCount: keywords.length,
        failedKeywordCount: failedResults.length,
        rawCount: results.reduce((sum, result) => sum + result.rawCount, 0),
        parsedCount: results.reduce(
          (sum, result) => sum + result.songs.length,
          0,
        ),
      });

      const uniqueResults = new Map<number, Song>();
      for (const result of results.flatMap((result) => result.songs)) {
        uniqueResults.set(result.resourceId, result);
      }

      const fallbackTitles = [title, alternativeTitle || ''].filter(Boolean);
      const scoreArtistNames = uniqBySearchText([
        ...artistNames,
        ...featuredArtistNames,
      ]);
      const rankedResults = Array.from(uniqueResults.values())
        .map((result) => {
          const song = result.baseInfo.simpleSongData;
          const itemArtists = song.ar?.map((item) => item.name) ?? [];
          const normalizedSongTitle = stripNoise(song.name) || song.name;
          const titleMatch = this.scoreTitle(
            normalizedSongTitle,
            candidates,
            fallbackTitles,
          );
          const artistScore = this.scoreArtist(itemArtists, scoreArtistNames);
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
        .sort((a, b) => {
          if (Math.abs(b.score - a.score) > 0.08) {
            return b.score - a.score;
          }
          return a.durationDelta - b.durationDelta;
        });
      debugNetEase('ranked results', {
        uniqueCount: uniqueResults.size,
        hasComparableDuration,
        scoreArtistNames,
        top: rankedResults.slice(0, 10).map((item) => ({
          id: item.result.resourceId,
          title: item.title,
          artists:
            item.result.baseInfo.simpleSongData.ar?.map(
              (artist) => artist.name,
            ) ?? [],
          titleScore: Number(item.titleScore.toFixed(3)),
          artistScore: Number(item.artistScore.toFixed(3)),
          durationDelta: Number(item.durationDelta.toFixed(3)),
          score: Number(item.score.toFixed(3)),
          ambiguousLatinTitle: item.ambiguousLatinTitle,
          latinOnlyTitle: item.latinOnlyTitle,
        })),
      });

      const strictResults = rankedResults.filter((item) =>
        this.isAllowedStrictMatch(
          item,
          hasComparableDuration,
          scoreArtistNames.length > 0,
        ),
      );
      const strictIds = new Set(
        strictResults.map((item) => item.result.resourceId),
      );
      const inexactResults = rankedResults.filter(
        (item) =>
          !strictIds.has(item.result.resourceId) &&
          this.isAllowedInexactMatch(
            item,
            hasComparableDuration,
            scoreArtistNames.length > 0,
          ),
      );
      const matches: CandidateMatch[] = [
        ...strictResults.map((item) => ({ ...item, strict: true })),
        ...inexactResults.map((item) => ({ ...item, strict: false })),
      ];
      if (matches.length === 0) {
        if (candidates.length) {
          debugNetEase('no match', {
            title,
            artist,
            showLyricsEvenIfInexact: config()?.showLyricsEvenIfInexact ?? true,
            keywords,
            failedKeywordCount: failedResults.length,
            artistNames,
            featuredArtistNames,
            scoreArtistNames,
            candidates: candidates.map((candidate) => candidate.title),
            best: rankedResults.slice(0, 5).map((item) => ({
              title: item.title,
              titleScore: item.titleScore,
              artistScore: item.artistScore,
              durationDelta: item.durationDelta,
              score: item.score,
            })),
          });
        }
        return null;
      }

      debugNetEase('candidate queue', {
        count: matches.length,
        top: matches.slice(0, 8).map((item) => ({
          id: item.result.resourceId,
          title: item.title,
          artists:
            item.result.baseInfo.simpleSongData.ar?.map(
              (artist) => artist.name,
            ) ?? [],
          strict: item.strict,
          titleScore: Number(item.titleScore.toFixed(3)),
          artistScore: Number(item.artistScore.toFixed(3)),
          durationDelta: Number(item.durationDelta.toFixed(3)),
          score: Number(item.score.toFixed(3)),
        })),
      });

      for (const selected of matches) {
        const closestResult = selected.result;
        const lyric = await this.getLyric(closestResult.resourceId);
        const rawLyrics = lyric?.lrc?.lyric ?? '';
        const lines = this.parseNetEaseLyrics(rawLyrics);
        debugNetEase('selected song', {
          id: closestResult.resourceId,
          title: closestResult.baseInfo.simpleSongData.name,
          artists:
            closestResult.baseInfo.simpleSongData.ar?.map(
              (item) => item.name,
            ) ?? [],
          duration: Math.round(closestResult.baseInfo.simpleSongData.dt / 1000),
          strict: selected.strict,
          rawLyricsLength: rawLyrics.length,
          parsedLineCount: lines.length,
          parsedTextLineCount: lines.filter((line) => line.text.trim()).length,
          hasTranslation: Boolean(lyric?.tlyric?.lyric?.trim()),
          hasRomanization: Boolean(lyric?.romalrc?.lyric?.trim()),
        });
        if (!lines.some((line) => line.text.trim())) {
          debugNetEase('skipped: selected lyric has no text', {
            id: closestResult.resourceId,
            title: closestResult.baseInfo.simpleSongData.name,
            rawLyricsLength: rawLyrics.length,
            rawLyricsPreview: rawLyrics.slice(0, 300),
          });
          continue;
        }

        const lyrics = this.plainLyricsFromLines(lines);
        const rawTranslatedLyrics = lyric?.tlyric?.lyric ?? '';
        const translatedLines = rawTranslatedLyrics
          ? this.parseNetEaseLyrics(rawTranslatedLyrics)
          : undefined;
        const hasTranslatedTimedLines =
          translatedLines?.some((line) => line.text.trim()) ?? false;
        const romanizedLyrics = stripMetadata(
          lyric?.romalrc?.lyric ?? '',
        ).trim();
        const romanizedLines = this.romanizedTextsFromLyrics(
          romanizedLyrics,
          lines,
        );
        const completeRomanizedLines = this.hasCompleteRomanization(
          lines,
          romanizedLines,
        )
          ? romanizedLines
          : undefined;
        const sourceLines = completeRomanizedLines
          ? lines.map((line, index) => ({
              ...line,
              romanizedText: completeRomanizedLines[index] ?? '',
            }))
          : lines;
        const translatedPlainLyrics = hasTranslatedTimedLines
          ? this.plainLyricsFromLines(translatedLines ?? [])
          : stripMetadata(rawTranslatedLyrics).trim();
        debugNetEase('match', {
          title: closestResult.baseInfo.simpleSongData.name,
          artists:
            closestResult.baseInfo.simpleSongData.ar?.map(
              (item) => item.name,
            ) ?? [],
          inexact: !selected.strict,
          lines: sourceLines.length,
          failedKeywordCount: failedResults.length,
        });

        return {
          title: closestResult.baseInfo.simpleSongData.name,
          artists:
            closestResult.baseInfo.simpleSongData.ar?.map(
              (item) => item.name,
            ) ?? [],
          lines: sourceLines,
          lyrics,
          romanizedLines: completeRomanizedLines,
          inexact: !selected.strict,
          translation: translatedPlainLyrics
            ? {
                lyrics: translatedPlainLyrics,
                lines: hasTranslatedTimedLines ? translatedLines : undefined,
                language: 'zh-CN',
                provider: this.name,
              }
            : undefined,
        };
      }

      debugNetEase('stopped: all matched lyrics have no text', {
        title,
        artist,
        tried: matches.map((item) => ({
          id: item.result.resourceId,
          title: item.title,
          artists:
            item.result.baseInfo.simpleSongData.ar?.map(
              (artist) => artist.name,
            ) ?? [],
          strict: item.strict,
        })),
      });
      return null;
    } catch (error) {
      debugNetEase('search failed fatally', {
        title,
        artist,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw toError(error, 'Unknown NetEase search error');
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
