import { describe, expect, it } from 'vitest';
import { PushPayloadSchema } from '../src/index.js';

const payload = {
  title: 'app',
  body: 'Terminou',
  machineId: 'm-1',
  workspaceId: 'w-1',
  sessionId: 's-1',
  kind: 'turn_end',
};

describe('PushPayloadSchema', () => {
  it('aceita payload válido', () => {
    expect(PushPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each(['turn_end', 'permission_request', 'error', 'file'])('aceita kind %s', (kind) => {
    expect(PushPayloadSchema.safeParse({ ...payload, kind }).success).toBe(true);
  });

  it.each(['status', 'user_message', ''])('rejeita kind %j fora do enum', (kind) => {
    expect(PushPayloadSchema.safeParse({ ...payload, kind }).success).toBe(false);
  });

  it.each(['title', 'body', 'machineId', 'workspaceId', 'sessionId'])(
    'rejeita %s vazio',
    (field) => {
      expect(PushPayloadSchema.safeParse({ ...payload, [field]: '' }).success).toBe(false);
    },
  );

  it('rejeita campo ausente', () => {
    const { body: _body, ...withoutBody } = payload;
    expect(PushPayloadSchema.safeParse(withoutBody).success).toBe(false);
  });
});
