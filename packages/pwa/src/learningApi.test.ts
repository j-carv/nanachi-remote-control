import { describe, expect, it } from 'vitest';
import { LearningSettingsSchema, type LearningNotice, type MemoryEntry } from '@nanachi/shared';
import { ApiError, createApiClient } from './api.js';

const reviewId = '11111111-1111-4111-8111-111111111111';
const entry: MemoryEntry = { id: '22222222-2222-4222-8222-222222222222', workspaceId: 'workspace/one', sourceWorkspace: { id: 'workspace/one', name: 'Project one', path: '/projects/one' }, kind: 'memory', title: 'Transactions', content: 'Use existing transaction helper.', status: 'active', version: 2, sourceSessionId: 's1', reviewId, evidenceSeqs: [1, 2], createdAt: 1, updatedAt: 2 };
const notice: LearningNotice = { reviewId, status: 'applied', summary: 'Saved transaction convention', memoryCount: 1, skillCount: 0, entryIds: [entry.id], sourceTurnSeq: 3 };
function setup(respond: (url: string, init: RequestInit | undefined) => unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const api = createApiClient({ baseUrl: 'http://127.0.0.1:7777', token: 'paired' }, async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(respond(url, init)), { status: 200, headers: { 'content-type': 'application/json' } }); });
  return { api, calls };
}

describe('typed learning client', () => {
  it('sends keys only in the authenticated save body and returns public settings without a secret', async () => {
    const settings = LearningSettingsSchema.parse({});
    const { api, calls } = setup(() => ({ ...settings, apiKeyConfigured: true }));
    const confirmed = await api.saveLearningSettings({ ...settings, apiKey: 'synthetic-secret' });
    expect(confirmed).not.toHaveProperty('apiKey');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/learning/settings');
    expect(calls[0]?.url).not.toContain('synthetic-secret');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer paired');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ enabled: false, reviewer: { source: 'same' }, apiKey: 'synthetic-secret' });
    expect(calls[0]?.init?.method).toBe('PUT');
    const leaking = setup(() => ({ ...settings, apiKeyConfigured: true, apiKey: 'must-not-return' }));
    await expect(leaking.api.learningSettings()).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('uses one global search and optimistic edit/forget API without resending source evidence', async () => {
    const { api, calls } = setup(() => ({ entries: [entry] }));
    expect(await api.listMemories({ query: 'transactions & locks', kind: 'memory' })).toEqual([entry]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/memories?query=transactions+%26+locks&kind=memory');
    await api.saveMemory({ id: entry.id, expectedVersion: entry.version, kind: entry.kind, title: entry.title, content: entry.content });
    expect(calls[1]?.url).toBe('http://127.0.0.1:7777/api/memories');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ id: entry.id, expectedVersion: 2, kind: entry.kind, title: entry.title, content: entry.content });
    await api.forgetMemory(entry.id, entry.version);
    expect(calls[2]?.url).toBe(`http://127.0.0.1:7777/api/memories/${entry.id}`);
    expect(calls[2]?.init?.method).toBe('DELETE');
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ expectedVersion: 2 });
  });

  it('refuses invalid optimistic mutations before touching the network', async () => {
    const { api, calls } = setup(() => ({}));
    await expect(api.saveMemory({ id: entry.id, kind: 'memory', title: 'Title', content: 'Content' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(api.forgetMemory(entry.id, 0)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it('accepts only confirmed notices for review actions, including rejection', async () => {
    const { api, calls } = setup((url) => ({ ...notice, status: url.endsWith('/reject') ? 'rejected' : url.endsWith('/revert') ? 'reverted' : 'applied' }));
    expect((await api.manageLearningReview(reviewId, 'approve')).status).toBe('applied');
    expect((await api.rejectLearningReview(reviewId)).status).toBe('rejected');
    expect((await api.manageLearningReview(reviewId, 'revert')).status).toBe('reverted');
    expect(calls.map((call) => call.url)).toEqual(['approve', 'reject', 'revert'].map((action) => `http://127.0.0.1:7777/api/learning/${reviewId}/${action}`));
    const malformed = setup(() => ({ ok: true }));
    await expect(malformed.api.manageLearningReview(reviewId, 'approve')).rejects.toMatchObject({ kind: 'unexpected' });
  });
});
