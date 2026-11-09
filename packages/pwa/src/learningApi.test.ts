import { describe, expect, it } from 'vitest';
import { LearningSettingsSchema, type LearningNotice, type MemoryEntry } from '@nanachi/shared';
import { ApiError, createApiClient } from './api.js';

const reviewId = '11111111-1111-4111-8111-111111111111';
const entry: MemoryEntry = { id: '22222222-2222-4222-8222-222222222222', workspaceId: 'workspace/one', kind: 'memory', title: 'Transactions', content: 'Use existing transaction helper.', status: 'active', version: 2, sourceSessionId: 's1', reviewId, evidenceSeqs: [1, 2], createdAt: 1, updatedAt: 2 };
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

  it('scopes search and optimistic edits/forget to the workspace, including encoded IDs', async () => {
    const { api, calls } = setup(() => ({ entries: [entry] }));
    expect(await api.listMemories(entry.workspaceId, { query: 'transactions & locks', kind: 'memory' })).toEqual([entry]);
    expect(calls[0]?.url).toContain('/api/workspaces/workspace%2Fone/memories?query=transactions+%26+locks&kind=memory');
    await api.saveMemory(entry.workspaceId, { id: entry.id, expectedVersion: entry.version, kind: entry.kind, title: entry.title, content: entry.content, evidenceSeqs: entry.evidenceSeqs });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ id: entry.id, expectedVersion: 2 });
    await api.forgetMemory(entry.workspaceId, entry.id, entry.version);
    expect(calls[2]?.init?.method).toBe('DELETE');
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ expectedVersion: 2 });
  });

  it('refuses invalid optimistic mutations before touching the network', async () => {
    const { api, calls } = setup(() => ({}));
    await expect(api.saveMemory('w1', { id: entry.id, kind: 'memory', title: 'Title', content: 'Content', evidenceSeqs: [] })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(api.forgetMemory('w1', entry.id, 0)).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });

  it('accepts only confirmed notices for review actions, including rejection', async () => {
    const { api, calls } = setup((url) => ({ ...notice, status: url.endsWith('/reject') ? 'rejected' : url.endsWith('/revert') ? 'reverted' : 'applied' }));
    expect((await api.manageLearningReview('w1', reviewId, 'approve')).status).toBe('applied');
    expect((await api.rejectLearningReview('w1', reviewId)).status).toBe('rejected');
    expect((await api.manageLearningReview('w1', reviewId, 'revert')).status).toBe('reverted');
    expect(calls.map((call) => call.url.split('/').at(-1))).toEqual(['approve', 'reject', 'revert']);
    const malformed = setup(() => ({ ok: true }));
    await expect(malformed.api.manageLearningReview('w1', reviewId, 'approve')).rejects.toMatchObject({ kind: 'unexpected' });
  });
});
