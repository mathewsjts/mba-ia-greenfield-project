import { generatePublicId } from './public-id';

describe('generatePublicId', () => {
  it('should produce an 11-character base64url string', () => {
    expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should produce distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generatePublicId()));
    expect(ids.size).toBe(1000);
  });
});
