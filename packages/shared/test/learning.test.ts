import { describe, expect, it } from 'vitest';
import {
  LearningReviewResultSchema,
  LearningSettingsSchema,
  MemoryToolInputSchema,
  MemoryWriteSchema,
  UpdateLearningSettingsSchema,
} from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const write = { kind: 'memory', title: 'Build procedure', content: 'Check the live supervisor before building.', evidenceSeqs: [12] };

describe('learning protocol boundaries', () => {
  it('requires optimistic versions for updates, but not new memories or reads', () => {
    expect(MemoryWriteSchema.safeParse(write).success).toBe(true);
    expect(MemoryWriteSchema.safeParse({ ...write, id }).success).toBe(false);
    expect(MemoryWriteSchema.safeParse({ ...write, expectedVersion: 2 }).success).toBe(false);
    expect(MemoryWriteSchema.safeParse({ ...write, id, expectedVersion: 2 }).success).toBe(true);
    expect(MemoryToolInputSchema.safeParse({ action: 'read', id }).success).toBe(true);
    expect(MemoryToolInputSchema.safeParse({ action: 'forget', id }).success).toBe(false);
    expect(MemoryToolInputSchema.safeParse({ action: 'forget', id, expectedVersion: 2 }).success).toBe(true);
  });

  it('does not allow the model to choose a workspace, session identity or credential', () => {
    for (const field of ['workspaceId', 'sessionId', 'apiKey', 'authorization']) {
      expect(MemoryToolInputSchema.safeParse({ action: 'search', query: 'build', [field]: 'untrusted' }).success).toBe(false);
    }
  });

  it('rejects incomplete saves and bounds review fanout and evidence', () => {
    expect(MemoryToolInputSchema.safeParse({ action: 'save', title: 'Build procedure' }).success).toBe(false);
    expect(MemoryToolInputSchema.safeParse({ action: 'save', title: 'Build procedure', content: '   ' }).success).toBe(false);
    expect(LearningReviewResultSchema.safeParse({ summary: 'Learned a procedure.', entries: [write] }).success).toBe(true);
    expect(LearningReviewResultSchema.safeParse({ summary: 'Too much.', entries: Array.from({ length: 9 }, () => write) }).success).toBe(false);
    expect(MemoryWriteSchema.safeParse({ ...write, evidenceSeqs: [-1] }).success).toBe(false);
    expect(MemoryWriteSchema.safeParse({ ...write, content: 'x'.repeat(12001) }).success).toBe(false);
  });

  it('bounds review resource settings independently of the selected provider', () => {
    const settings = LearningSettingsSchema.parse({});
    expect(UpdateLearningSettingsSchema.safeParse({ ...settings, apiKey: 'synthetic-secret' }).success).toBe(true);
    for (const patch of [{ intervalTurns: 0 }, { maxInputChars: 100001 }, { maxOutputTokens: 8193 }, { timeoutMs: 0 }]) {
      expect(UpdateLearningSettingsSchema.safeParse({ ...settings, ...patch }).success).toBe(false);
    }
    expect(UpdateLearningSettingsSchema.safeParse({ ...settings, reviewer: { ...settings.reviewer, source: 'unsupported' } }).success).toBe(false);
  });
});
