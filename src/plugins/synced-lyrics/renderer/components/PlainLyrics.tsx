import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from 'solid-js';

import {
  canonicalize,
  convertChineseCharacter,
  romanize,
  simplifyUnicode,
} from '../utils';
import { config } from '../renderer';
import { getLineTranslation } from '../translation-store';
import { lyricsStore } from '../store';
import { ProviderNames } from '../../providers';

interface PlainLyricsProps {
  line: string;
  index: number;
  romanizedLine?: string;
}

export const PlainLyrics = (props: PlainLyricsProps) => {
  const [romanization, setRomanization] = createSignal('');
  const text = createMemo(() => {
    let line = props.line;
    const convertChineseText = config()?.convertChineseCharacter;
    if (convertChineseText && convertChineseText !== 'disabled') {
      line = convertChineseCharacter(line, convertChineseText);
    }
    return line;
  });

  createEffect(() => {
    if (!config()?.romanization) {
      setRomanization('');
      return;
    }

    const sourceRomanization = props.romanizedLine?.trim();
    if (sourceRomanization) {
      setRomanization(canonicalize(sourceRomanization));
      return;
    }

    if (lyricsStore.provider === ProviderNames.NetEase) {
      setRomanization('');
      return;
    }

    const input = canonicalize(text());
    let stale = false;
    onCleanup(() => {
      stale = true;
    });

    romanize(input).then((result) => {
      if (stale) return;
      setRomanization(canonicalize(result));
    });
  });

  const translation = createMemo(() => {
    if (!config()?.translation?.enabled) return '';
    const videoId = lyricsStore.videoId;
    if (!videoId) return '';
    return getLineTranslation(videoId, props.index) ?? '';
  });

  return (
    <div
      class={`${
        props.line.match(/^\[.+\]$/s) ? 'lrc-header' : ''
      } text-lyrics description ytmusic-description-shelf-renderer`}
      style={{
        'display': 'flex',
        'flex-direction': 'column',
      }}
    >
      <yt-formatted-string
        text={{
          runs: [{ text: text() }],
        }}
      />
      <Show
        when={
          config()?.romanization &&
          simplifyUnicode(text()) !== simplifyUnicode(romanization())
        }
      >
        <yt-formatted-string
          class="romaji"
          text={{
            runs: [{ text: romanization() }],
          }}
        />
      </Show>
      <Show
        when={
          translation() &&
          simplifyUnicode(text()) !== simplifyUnicode(translation())
        }
      >
        <yt-formatted-string
          class="translation"
          text={{
            runs: [{ text: translation() }],
          }}
        />
      </Show>
    </div>
  );
};
