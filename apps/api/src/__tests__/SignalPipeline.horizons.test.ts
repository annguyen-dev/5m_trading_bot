import { describe, it, expect } from 'vitest';
import { selectHorizons } from '../pipeline/SignalPipeline.js';

describe('SignalPipeline — selectHorizons', () => {
  it('returns [long] only for low-sentiment events (< 0.3)', () => {
    expect(selectHorizons(0)).toEqual(['long']);
    expect(selectHorizons(0.1)).toEqual(['long']);
    expect(selectHorizons(0.29)).toEqual(['long']);
  });

  it('returns [mid, long] for moderate sentiment (0.3 – 0.59)', () => {
    expect(selectHorizons(0.3)).toEqual(['mid', 'long']);
    expect(selectHorizons(0.45)).toEqual(['mid', 'long']);
    expect(selectHorizons(0.59)).toEqual(['mid', 'long']);
  });

  it('returns [short, mid, long] for high sentiment (≥ 0.6)', () => {
    expect(selectHorizons(0.6)).toEqual(['short', 'mid', 'long']);
    expect(selectHorizons(0.8)).toEqual(['short', 'mid', 'long']);
    expect(selectHorizons(1.0)).toEqual(['short', 'mid', 'long']);
  });

  it('always receives absolute value — negative sentiment should be passed as |x|', () => {
    // selectHorizons takes absSentiment — caller must do Math.abs first
    // High abs value → all horizons
    expect(selectHorizons(0.95)).toEqual(['short', 'mid', 'long']);
  });
});
