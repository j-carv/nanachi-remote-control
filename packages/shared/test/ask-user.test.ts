import { describe, expect, it } from 'vitest';
import { AskUserInputSchema, AskUserRequestSchema, AskUserResultSchema, RespondUserQuestionRequestSchema, SessionEventSchema } from '../src/index.js';

const options = [{ id: 'migrate', label: 'Preserve existing data' }, { id: 'recreate', label: 'Recreate development database' }];
const question = { question: 'How should we update the database?', options };
const requestId = '00000000-0000-4000-8000-000000000001';

describe('ask_user decision safety', () => {
  it('rejects ambiguous option IDs and empty or unbounded question choices', () => {
    for (const input of [
      { ...question, question: '   ' },
      { ...question, options: [options[0]] },
      { ...question, options: [options[0], options[0]] },
      { ...question, options: Array.from({ length: 9 }, (_, index) => ({ id: `option-${index}`, label: 'Choice' })) },
      { ...question, options: [{ id: ' ', label: 'Choice' }, options[1]] },
      { ...question, options: [{ id: 'valid', label: '   ' }, options[1]] },
    ]) expect(AskUserInputSchema.safeParse(input).success).toBe(false);
  });

  it('does not let the model override request identity or session credentials', () => {
    for (const extra of [{ requestId }, { sessionId: 'other-session' }, { token: 'model-token' }]) {
      expect(AskUserInputSchema.safeParse({ ...question, ...extra }).success).toBe(false);
    }
    expect(AskUserRequestSchema.parse({ ...question, requestId }).requestId).toBe(requestId);
  });

  it('a non-answer cannot contain a selected option and an answer must identify the selected option', () => {
    expect(AskUserResultSchema.safeParse({ status: 'answered' }).success).toBe(false);
    expect(AskUserResultSchema.safeParse({ status: 'cancelled', reason: 'expired', option: options[0] }).success).toBe(false);
    expect(AskUserResultSchema.safeParse({ status: 'cancelled', reason: 'disconnected', optionId: 'migrate' }).success).toBe(false);
    expect(AskUserResultSchema.parse({ status: 'answered', option: options[1] })).toEqual({ status: 'answered', option: options[1] });
  });

  it('requires an explicit option or explicit cancellation from a device', () => {
    expect(RespondUserQuestionRequestSchema.safeParse({}).success).toBe(false);
    expect(RespondUserQuestionRequestSchema.safeParse({ optionId: '' }).success).toBe(false);
    expect(RespondUserQuestionRequestSchema.parse({ optionId: null })).toEqual({ optionId: null });
  });

  it('rejects duplicate options in persisted events rather than replaying ambiguous buttons', () => {
    expect(SessionEventSchema.safeParse({
      kind: 'user_question', seq: 1, sessionId: 'session', ts: 1, requestId,
      question: question.question, options: [options[0], options[0]], expiresAt: 1000,
    }).success).toBe(false);
  });
});
