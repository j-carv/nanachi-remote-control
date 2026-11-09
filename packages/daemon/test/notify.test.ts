import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@nanachi/shared';
import { notifyOf } from '../src/notify.js';

const meta = { seq: 1, sessionId: 's', ts: 1 } as const;

describe('notifyOf', () => {
  it('turn_end, permission_request, error e file viram aviso com o próprio evento como detalhe', () => {
    const turnEnd: SessionEvent = { ...meta, kind: 'turn_end', stopReason: 'end_turn' };
    const error: SessionEvent = { ...meta, kind: 'error', message: 'falhou' };
    const file: SessionEvent = {
      ...meta,
      kind: 'file',
      fileId: 'f',
      name: 'a.png',
      mime: 'image/png',
      size: 3,
      direction: 'to_phone',
    };

    expect(notifyOf(turnEnd)).toEqual({ kind: 'turn_end', details: turnEnd });
    expect(notifyOf(error)).toEqual({ kind: 'error', details: error });
    expect(notifyOf(file)).toEqual({ kind: 'file', details: file });
  });

  it('turn_end com stopReason error não avisa como concluído (o evento error do mesmo turno já avisou)', () => {
    const failed: SessionEvent = { ...meta, kind: 'turn_end', stopReason: 'error' };
    expect(notifyOf(failed)).toBeUndefined();
  });

  it('terminal_exit (fim de sessão PTY) avisa como turn_end, com o próprio evento como detalhe', () => {
    const exit: SessionEvent = { ...meta, kind: 'terminal_exit', exitCode: 3 };
    expect(notifyOf(exit)).toEqual({ kind: 'turn_end', details: exit });
  });

  it('announces new file requests and previews, never their settled events', () => {
    const requestId = '50efca7a-6ceb-4bd5-8c38-d6ab7f317ce9';
    const request: SessionEvent = { ...meta, kind: 'file_request', requestId, prompt: 'Choose a file', expiresAt: 100 };
    const preview: SessionEvent = { ...meta, kind: 'preview', previewId: requestId, port: 3000, title: 'App', path: '/', expiresAt: 100 };
    expect(notifyOf(request)).toEqual({ kind: 'file_request', details: request });
    expect(notifyOf(preview)).toEqual({ kind: 'preview', details: preview });
    expect(notifyOf({ ...meta, kind: 'file_request_resolved', requestId, result: { status: 'cancelled', reason: 'user_cancelled' } })).toBeUndefined();
    expect(notifyOf({ ...meta, kind: 'preview_closed', previewId: requestId, reason: 'closed' })).toBeUndefined();
  });

  it('demais eventos não avisam', () => {
    const chunk: SessionEvent = { ...meta, kind: 'agent_message_chunk', text: 'oi' };
    const status: SessionEvent = { ...meta, kind: 'status', status: 'idle' };
    expect(notifyOf(chunk)).toBeUndefined();
    expect(notifyOf(status)).toBeUndefined();
  });
});
