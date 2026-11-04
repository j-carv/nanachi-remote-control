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

  it('terminal_exit (fim de sessão PTY) avisa como turn_end, com o próprio evento como detalhe', () => {
    const exit: SessionEvent = { ...meta, kind: 'terminal_exit', exitCode: 3 };
    expect(notifyOf(exit)).toEqual({ kind: 'turn_end', details: exit });
  });

  it('demais eventos não avisam', () => {
    const chunk: SessionEvent = { ...meta, kind: 'agent_message_chunk', text: 'oi' };
    const status: SessionEvent = { ...meta, kind: 'status', status: 'idle' };
    expect(notifyOf(chunk)).toBeUndefined();
    expect(notifyOf(status)).toBeUndefined();
  });
});
