import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LearningNotice, SessionEvent } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { applyEvents, createChatState, withLearningNotice } from './reducer.js';
import { conversationItemCount, isLearningOnlyChange } from './learning.js';
import { readableSequence, firstUnreadIndex } from './chatVisit.js';
import { LearningNoticeView } from './LearningNotice.js';

const notice: LearningNotice = { reviewId: '11111111-1111-4111-8111-111111111111', status: 'pending', summary: 'Use the existing transaction helper.', memoryCount: 1, skillCount: 1, entryIds: ['22222222-2222-4222-8222-222222222222'], sourceTurnSeq: 3 };
const event = (seq: number, body: object): SessionEvent => ({ sessionId: 's1', seq, ts: seq, ...body }) as SessionEvent;
const initial = () => applyEvents(createChatState('idle'), [event(1, { kind: 'user_message', text: 'First task' }), event(2, { kind: 'agent_message_chunk', text: 'Finished first task' }), event(3, { kind: 'turn_end' }), event(4, { kind: 'user_message', text: 'Second task' })]);

describe('learning conversation consumer', () => {
  it('associates a delayed review with the source task and updates that exact row', () => {
    const before = initial();
    const proposed = applyEvents(before, [event(5, { kind: 'learning', ...notice })]);
    expect(proposed.items.map((item) => item.kind)).toEqual(['user_message', 'agent_message', 'learning', 'user_message']);
    const applied = withLearningNotice(proposed, { ...notice, status: 'applied' });
    const reverted = applyEvents(applied, [event(6, { kind: 'learning', ...notice, status: 'reverted' })]);
    expect(reverted.items).toHaveLength(4);
    expect(reverted.items[2]).toMatchObject({ id: `learning-${notice.reviewId}`, status: 'reverted' });
    expect(reverted.items[3]).toBe(before.items[2]);
    expect(reverted.turnEnds).toBe(before.turnEnds);
    expect(reverted.status).toBe(before.status);
  });

  it('keeps learning-only additions and review actions out of scroll activity and unread messages', () => {
    const before = initial();
    const after = withLearningNotice(before, notice);
    expect(isLearningOnlyChange(before.items, after.items)).toBe(true);
    expect(conversationItemCount(after.items)).toBe(conversationItemCount(before.items));
    const learning = after.items.find((item) => item.kind === 'learning');
    if (learning === undefined) throw new Error('Expected learning row');
    expect(readableSequence(learning)).toBeUndefined();
    expect(firstUnreadIndex([learning], 3)).toBe(-1);
    const response = applyEvents(after, [event(6, { kind: 'agent_message_chunk', text: 'New task answer' })]);
    expect(isLearningOnlyChange(after.items, response.items)).toBe(false);
  });

  it('does not show a zero-change review, but keeps confirmed rejection on its original row', () => {
    const before = initial();
    expect(withLearningNotice(before, { ...notice, memoryCount: 0, skillCount: 0 }).items).toEqual(before.items);
    const rejected = withLearningNotice(withLearningNotice(before, notice), { ...notice, status: 'rejected', entryIds: [], memoryCount: 0, skillCount: 0 });
    expect(rejected.items.filter((item) => item.kind === 'learning')).toHaveLength(1);
    expect(rejected.items[2]).toMatchObject({ status: 'rejected' });
  });

  it('renders a collapsed event with escaped details and only applicable confirmed-review actions', () => {
    const api = {} as ApiClient;
    const render = (status: LearningNotice['status']) => renderToStaticMarkup(createElement(LearningNoticeView, { notice: { ...notice, status, summary: '<script>unsafe</script>' }, api, onManage: async () => undefined }));
    const pending = render('pending');
    expect(pending).toContain('<details');
    expect(pending).not.toMatch(/<details[^>]*\sopen/);
    expect(pending).toContain('data-slot="learning-approve"');
    expect(pending).toContain('data-slot="learning-reject"');
    expect(pending).toContain('data-slot="learning-inspect"');
    expect(pending).not.toContain('<script>');
    expect(pending).not.toContain('data-slot="agent-text"');
    expect(render('applied')).toContain('data-slot="learning-revert"');
    for (const status of ['failed', 'reverted', 'rejected'] as const) expect(render(status)).not.toMatch(/data-slot="learning-(approve|reject|revert)"/);
  });
});
