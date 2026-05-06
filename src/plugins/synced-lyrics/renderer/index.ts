import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { selectors, tabStates } from './utils';
import { setConfig, setCurrentTime } from './renderer';
import { refreshCurrentLyrics } from './store';
import { setTranslationDebugSender, translationDebug } from './debug';
import { clearTranslationMemoryCacheForVideo } from './translation-store';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
import type { SongInfo } from '@/providers/song-info';
import type {
  LyricResult,
  SyncedLyricsPluginConfig,
  TranslationProviderName,
  TranslationProviderSettings,
} from '../types';
import type { TranslationRequest } from '../translation/types';

export let _ytAPI: MusicPlayer | null = null;
export let netFetch: (
  url: string,
  init?: RequestInit,
) => Promise<[number, string, Record<string, string>]>;

export interface TranslateInvokeArgs {
  videoId: string;
  request: TranslationRequest;
  provider: TranslationProviderName;
  settings: TranslationProviderSettings[TranslationProviderName];
}

export let translateInvoke: (args: TranslateInvokeArgs) => Promise<{
  lines: string[];
  fromCache: boolean;
  error?: string;
}>;

type SyncedLyricsDebugWindow = Window & {
  __ytmdDebugNetEase?: (
    overrides?: Partial<SongInfo>,
  ) => Promise<LyricResult | null>;
};

export const renderer = createRenderer<
  {
    observerCallback: MutationCallback;
    observer?: MutationObserver;
    videoDataChange: () => Promise<void>;
    updateTimestampInterval?: NodeJS.Timeout | string | number;
    videoDataDocumentListener?: EventListener;
  },
  SyncedLyricsPluginConfig
>({
  onConfigChange(newConfig) {
    setConfig(newConfig);
    refreshCurrentLyrics('config-change');
  },

  observerCallback(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      const header = mutation.target as HTMLElement;

      switch (mutation.attributeName) {
        case 'disabled':
          header.removeAttribute('disabled');
          break;
        case 'aria-selected':
          tabStates[header.ariaSelected ?? 'false']();
          break;
      }
    }
  },

  async onPlayerApiReady(api: MusicPlayer) {
    _ytAPI = api;

    api.addEventListener('videodatachange', this.videoDataChange);

    await this.videoDataChange();
    refreshCurrentLyrics('player-api-ready');
  },
  async videoDataChange() {
    if (!this.updateTimestampInterval) {
      this.updateTimestampInterval = setInterval(
        () => setCurrentTime((_ytAPI?.getCurrentTime() ?? 0) * 1000),
        100,
      );
    }

    // prettier-ignore
    this.observer ??= new MutationObserver(this.observerCallback);
    this.observer.disconnect();

    // Force the lyrics tab to be enabled at all times.
    const header = await waitForElement<HTMLElement>(selectors.head);
    {
      header.removeAttribute('disabled');
      tabStates[header.ariaSelected ?? 'false']();
    }

    this.observer.observe(header, { attributes: true });
    header.removeAttribute('disabled');
  },

  async start(ctx: RendererContext<SyncedLyricsPluginConfig>) {
    netFetch = ctx.ipc.invoke.bind(ctx.ipc, 'synced-lyrics:fetch');
    translateInvoke = ctx.ipc.invoke.bind(
      ctx.ipc,
      'synced-lyrics:translate',
    ) as typeof translateInvoke;
    setTranslationDebugSender((message, data) => {
      ctx.ipc.send('synced-lyrics:translation-debug', message, data);
    });

    setConfig(await ctx.getConfig());
    (window as SyncedLyricsDebugWindow).__ytmdDebugNetEase = async (
      overrides = {},
    ) => {
      const [{ getSongInfo }, { ProviderNames }, { providers }] =
        await Promise.all([
          import('@/providers/song-info-front'),
          import('../providers'),
          import('../providers/renderer'),
        ]);
      const info = {
        ...getSongInfo(),
        ...overrides,
      };
      console.info('[synced-lyrics] manual NetEase debug input', {
        videoId: info.videoId,
        title: info.title,
        alternativeTitle: info.alternativeTitle,
        artist: info.artist,
        songDuration: info.songDuration,
        tags: info.tags ?? [],
      });
      const result = await providers[ProviderNames.NetEase].search(info);
      console.info('[synced-lyrics] manual NetEase debug result', {
        hasResult: Boolean(result),
        title: result?.title,
        artists: result?.artists,
        lineCount: result?.lines?.length ?? 0,
        textLineCount:
          result?.lines?.filter((line) => line.text.trim()).length ?? 0,
        plainLength: result?.lyrics?.length ?? 0,
        inexact: result?.inexact,
      });
      return result;
    };
    refreshCurrentLyrics('renderer-start');
    setTimeout(() => refreshCurrentLyrics('renderer-start-delayed'), 1500);

    ctx.ipc.on('peard:update-song-info', (info: SongInfo) => {
      translationDebug('song-info update', {
        videoId: info.videoId,
        title: info.title,
      });
      refreshCurrentLyrics('song-info-update', info);
    });

    ctx.ipc.on('synced-lyrics:clear-current-translation-cache', async () => {
      const videoId = _ytAPI?.getVideoData?.()?.video_id;
      if (!videoId) {
        translationDebug('current translation cache clear skipped', {
          reason: 'no active video',
        });
        return;
      }

      const diskEntries = (await ctx.ipc
        .invoke('synced-lyrics:translate-clear-video-cache', videoId)
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          translationDebug('current translation disk cache clear failed', {
            videoId,
            message,
          });
          return 0;
        })) as number;
      const memoryEntries = clearTranslationMemoryCacheForVideo(videoId);
      translationDebug('current translation cache cleared', {
        videoId,
        diskEntries,
        memoryEntries,
      });
      refreshCurrentLyrics('current-translation-cache-cleared');
    });

    this.videoDataDocumentListener = () => {
      setTimeout(() => refreshCurrentLyrics('document-videodatachange'), 0);
    };
    document.addEventListener(
      'videodatachange',
      this.videoDataDocumentListener,
    );
  },

  stop() {
    window.ipcRenderer?.removeAllListeners?.(
      'synced-lyrics:clear-current-translation-cache',
    );

    if (this.videoDataDocumentListener) {
      document.removeEventListener(
        'videodatachange',
        this.videoDataDocumentListener,
      );
      this.videoDataDocumentListener = undefined;
    }
  },
});
