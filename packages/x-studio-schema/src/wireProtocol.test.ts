import { describe, it, expect } from 'vitest';
import {
  checkStudioWireVersion,
  MIN_SUPPORTED_STUDIO_AI_WIRE_VERSION,
  MIN_SUPPORTED_STUDIO_DATA_WIRE_VERSION,
  STUDIO_AI_WIRE_VERSION,
  STUDIO_DATA_WIRE_VERSION,
} from './wireProtocol';

describe('wire protocol versions', () => {
  it('keeps each MIN_SUPPORTED at or below its CURRENT', () => {
    // A MIN_SUPPORTED above CURRENT makes a server refuse the version its own client stamps —
    // every request fails, and the message blames the client. Cheap to assert, impossible to
    // notice by reading two constants a hundred lines apart.
    expect(MIN_SUPPORTED_STUDIO_AI_WIRE_VERSION).toBeLessThanOrEqual(STUDIO_AI_WIRE_VERSION);
    expect(MIN_SUPPORTED_STUDIO_DATA_WIRE_VERSION).toBeLessThanOrEqual(STUDIO_DATA_WIRE_VERSION);
  });

  it('accepts the version this build stamps, on both wires', () => {
    expect(checkStudioWireVersion('ai', STUDIO_AI_WIRE_VERSION)).toEqual({
      compatible: true,
      version: STUDIO_AI_WIRE_VERSION,
    });
    expect(checkStudioWireVersion('data', STUDIO_DATA_WIRE_VERSION)).toEqual({
      compatible: true,
      version: STUDIO_DATA_WIRE_VERSION,
    });
  });

  it('refuses an absent version as a pre-versioning client, not as a malformed one', () => {
    // The distinction is the whole point: "you are older than versioning" is actionable,
    // "expected a number" sends the host to look at a field they never wrote.
    for (const absent of [undefined, null]) {
      const result = checkStudioWireVersion('data', absent);
      expect(result.compatible).toBe(false);
      expect(result).toMatchObject({ reason: 'absent' });
      expect(!result.compatible && result.message).toContain('older than');
    }
  });

  it('refuses a non-integer version as malformed', () => {
    for (const bad of ['1', 1.5, -1, Number.NaN, {}, []]) {
      const result = checkStudioWireVersion('ai', bad);
      expect(result.compatible).toBe(false);
      expect(result).toMatchObject({ reason: 'malformed', received: bad });
    }
  });

  it('refuses a client older than MIN_SUPPORTED', () => {
    const result = checkStudioWireVersion('data', MIN_SUPPORTED_STUDIO_DATA_WIRE_VERSION - 1);
    expect(result).toMatchObject({ reason: 'too-old' });
  });

  it('refuses a client NEWER than the server', () => {
    // The case a permissive rule gets wrong. A newer client may send fields this server drops,
    // so accepting produces a dashboard rendered from an incomplete query rather than an error.
    const result = checkStudioWireVersion('ai', STUDIO_AI_WIRE_VERSION + 1);
    expect(result).toMatchObject({ reason: 'too-new' });
    expect(!result.compatible && result.message).toContain('NEWER than the server');
  });

  it('names the right package and wire in every refusal', () => {
    // A host running two servers needs to know WHICH one to upgrade. Getting this backwards
    // sends them to redeploy the service that was already correct.
    const ai = checkStudioWireVersion('ai', 0);
    const data = checkStudioWireVersion('data', 0);
    expect(!ai.compatible && ai.message).toContain('@mui/x-studio-ai-middleware');
    expect(!ai.compatible && ai.message).toContain('AI chat');
    expect(!data.compatible && data.message).toContain('@mui/x-studio-data-middleware');
    expect(!data.compatible && data.message).toContain('batch query');
  });
});
