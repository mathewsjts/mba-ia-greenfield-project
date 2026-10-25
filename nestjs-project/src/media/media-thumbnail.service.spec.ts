import { thumbnailOffset } from './media-thumbnail.service';

describe('thumbnailOffset', () => {
  it('should pick the frame at 10% of the duration', () => {
    expect(thumbnailOffset(120)).toBe(12);
    expect(thumbnailOffset(1)).toBeCloseTo(0.1);
  });

  it('should fall back to the first frame below 1 second or without duration', () => {
    expect(thumbnailOffset(0.5)).toBe(0);
    expect(thumbnailOffset(null)).toBe(0);
  });
});
