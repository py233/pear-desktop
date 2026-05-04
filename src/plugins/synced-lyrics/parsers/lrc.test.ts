import { test, expect } from '@playwright/test';

import { LRC } from './lrc';

test('empty string', () => {
  const lrc = LRC.parse('');
  expect(lrc).toStrictEqual({ lines: [], tags: [] });
});

test('chorus', () => {
  const lrc = LRC.parse(`\
[00:12.00]Line 1 lyrics
[00:17.20]Line 2 lyrics
[00:21.10][00:45.10]Repeating lyrics (e.g. chorus)
[mm:ss.xx]Last lyrics line\
`);

  expect(lrc).toStrictEqual({
    lines: [
      { duration: 12000, text: '', words: [], time: '00:00:00', timeInMs: 0 },
      {
        duration: 5200,
        text: 'Line 1 lyrics',
        words: [],
        time: '00:12:00',
        timeInMs: 12000,
      },
      {
        duration: 3900,
        text: 'Line 2 lyrics',
        words: [],
        time: '00:17:20',
        timeInMs: 17200,
      },
      {
        duration: 24000,
        text: 'Repeating lyrics (e.g. chorus)',
        words: [],
        time: '00:21:10',
        timeInMs: 21100,
      },
      {
        duration: Infinity,
        text: 'Repeating lyrics (e.g. chorus)',
        words: [],
        time: '00:45:10',
        timeInMs: 45100,
      },
    ],
    tags: [],
  });
});

test('attributes', () => {
  const lrc = LRC.parse(
    `[ar:Chubby Checker oppure  Beatles, The]
[al:Hits Of The 60's - Vol. 2 – Oldies]
[ti:Let's Twist Again]
[au:Written by Kal Mann / Dave Appell, 1961]
[length: 2:23]

[00:12.00]Naku Penda Piya-Naku Taka Piya-Mpenziwe
[00:15.30]Some more lyrics ...`,
  );

  expect(lrc).toStrictEqual({
    lines: [
      { duration: 12000, text: '', words: [], time: '00:00:00', timeInMs: 0 },
      {
        duration: 3300,
        text: 'Naku Penda Piya-Naku Taka Piya-Mpenziwe',
        words: [],
        time: '00:12:00',
        timeInMs: 12000,
      },
      {
        duration: Infinity,
        text: 'Some more lyrics ...',
        words: [],
        time: '00:15:30',
        timeInMs: 15300,
      },
    ],
    tags: [
      { tag: 'ar', value: 'Chubby Checker oppure  Beatles, The' },
      { tag: 'al', value: "Hits Of The 60's - Vol. 2 – Oldies" },
      { tag: 'ti', value: "Let's Twist Again" },
      { tag: 'au', value: 'Written by Kal Mann / Dave Appell, 1961' },
      { tag: 'length', value: '2:23' },
    ],
  });
});

test('colon-separated centiseconds', () => {
  const lrc = LRC.parse(`\
[00:15:41]何が優しさで
[00:16:48]何が幸せ？\
`);

  expect(lrc.lines).toStrictEqual([
    { duration: 15410, text: '', words: [], time: '00:00:00', timeInMs: 0 },
    {
      duration: 1070,
      text: '何が優しさで',
      words: [],
      time: '00:15:41',
      timeInMs: 15410,
    },
    {
      duration: Infinity,
      text: '何が幸せ？',
      words: [],
      time: '00:16:48',
      timeInMs: 16480,
    },
  ]);
});

test('timestamps without centiseconds', () => {
  const lrc = LRC.parse(`\
[00:12]Line without centiseconds
[00：16]Fullwidth colon timestamp\
`);

  expect(lrc.lines).toStrictEqual([
    { duration: 12000, text: '', words: [], time: '00:00:00', timeInMs: 0 },
    {
      duration: 4000,
      text: 'Line without centiseconds',
      words: [],
      time: '00:12:00',
      timeInMs: 12000,
    },
    {
      duration: Infinity,
      text: 'Fullwidth colon timestamp',
      words: [],
      time: '00:16:00',
      timeInMs: 16000,
    },
  ]);
});

test('karaoke', () => {
  const lrc = LRC.parse(
    '[00:00.00] <00:00.04> When <00:00.16> the <00:00.82> truth <00:01.29> is <00:01.63> found <00:03.09> to <00:03.37> be <00:05.92> lies',
  );

  expect(lrc).toStrictEqual({
    lines: [
      {
        duration: Infinity,
        text: 'When the truth is found to be lies',
        time: '00:00:00',
        timeInMs: 0,
        words: [
          {
            timeInMs: 40,
            word: 'When',
          },
          {
            timeInMs: 160,
            word: 'the',
          },
          {
            timeInMs: 820,
            word: 'truth',
          },
          {
            timeInMs: 1290,
            word: 'is',
          },
          {
            timeInMs: 1630,
            word: 'found',
          },
          {
            timeInMs: 3090,
            word: 'to',
          },
          {
            timeInMs: 3370,
            word: 'be',
          },
          {
            timeInMs: 5920,
            word: 'lies',
          },
        ],
      },
    ],
    tags: [],
  });
});
