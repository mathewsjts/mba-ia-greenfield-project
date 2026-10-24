import { classifyFormat } from './media-format';
import type { ProbeResult } from './media-probe.service';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const WEBM = 'matroska,webm';

const probe = (overrides: Partial<ProbeResult>): ProbeResult => ({
  duration: 2,
  width: 320,
  height: 240,
  formatName: MP4,
  videoCodec: 'h264',
  audioCodec: 'aac',
  ...overrides,
});

describe('classifyFormat', () => {
  it.each([
    [MP4, 'h264', 'aac', 'mp4'],
    [MP4, 'vp9', 'opus', 'mp4'],
    [MP4, 'av1', 'mp3', 'mp4'],
    [WEBM, 'vp8', 'vorbis', 'webm'],
    [WEBM, 'vp9', 'opus', 'webm'],
    [WEBM, 'av1', 'opus', 'webm'],
  ])(
    'should accept %s with %s + %s as %s',
    (formatName, videoCodec, audioCodec, container) => {
      expect(
        classifyFormat(probe({ formatName, videoCodec, audioCodec })),
      ).toEqual({ supported: true, container });
    },
  );

  it('should accept a video without an audio stream', () => {
    expect(classifyFormat(probe({ audioCodec: null }))).toEqual({
      supported: true,
      container: 'mp4',
    });
  });

  it.each([
    ['HEVC in MP4', { videoCodec: 'hevc' }],
    ['VP8 in MP4', { videoCodec: 'vp8' }],
    ['H.264 in WebM/Matroska', { formatName: WEBM, videoCodec: 'h264' }],
    ['an audio codec outside the list', { audioCodec: 'ac3' }],
    ['an AVI container', { formatName: 'avi' }],
  ])('should reject %s', (_label, overrides: Partial<ProbeResult>) => {
    expect(classifyFormat(probe(overrides))).toEqual({ supported: false });
  });
});
