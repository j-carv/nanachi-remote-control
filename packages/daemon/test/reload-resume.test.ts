import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import {
  RESUME_CONCURRENCY,
  RESUME_FILE_NAME,
  RESUME_MAX_AGE_MS,
  resumeAfterReload,
  saveIdleSessionsForReload,
  takeResumeAfterReload,
} from '../src/reload-resume.js';
import { insertSession, insertWorkspace } from '../src/repository.js';
import { removeTempDir } from './temp.js';

let home: string;
let db: Database.Database;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nanachi-resume-'));
  db = openDatabase(join(home, 'data.db'));
  insertWorkspace(db, { id: 'w1', name: 'p', path: join(home, 'p'), createdAt: 1, muted: false });
});

afterEach(async () => {
  db.close();
  await removeTempDir(home);
});

function fileOf(): string {
  return join(home, RESUME_FILE_NAME);
}

async function fileExists(): Promise<boolean> {
  return stat(fileOf()).then(
    () => true,
    () => false,
  );
}

describe('saveIdleSessionsForReload', () => {
  it('grava só sessões idle do tipo acp (não stopped, error, pty, starting nem running)', async () => {
    insertSession(db, { id: 'ociosa', workspaceId: 'w1', agent: 'omp', title: 't', status: 'idle', createdAt: 1 });
    insertSession(db, { id: 'parada', workspaceId: 'w1', agent: 'omp', title: 't', status: 'stopped', createdAt: 2 });
    insertSession(db, { id: 'erro', workspaceId: 'w1', agent: 'omp', title: 't', status: 'error', createdAt: 3 });
    insertSession(db, { id: 'terminal', workspaceId: 'w1', agent: 'agy', kind: 'pty', title: 't', status: 'idle', createdAt: 4 });
    insertSession(db, { id: 'subindo', workspaceId: 'w1', agent: 'omp', title: 't', status: 'starting', createdAt: 5 });
    insertSession(db, { id: 'rodando', workspaceId: 'w1', agent: 'omp', title: 't', status: 'running', createdAt: 6 });

    const saved = saveIdleSessionsForReload(db, home, 1_000);

    expect(saved).toEqual(['ociosa']);
    const raw: unknown = JSON.parse(await readFile(fileOf(), 'utf8'));
    expect(raw).toEqual({ savedAt: 1_000, sessionIds: ['ociosa'] });
  });
});

describe('takeResumeAfterReload', () => {
  it('lê os ids gravados recentemente e apaga o arquivo', async () => {
    saveIdleSessionsForReload(db, home, 1_000);
    insertSession(db, { id: 'a', workspaceId: 'w1', agent: 'omp', title: 't', status: 'idle', createdAt: 1 });
    saveIdleSessionsForReload(db, home, 1_000);

    expect(takeResumeAfterReload(home, 1_000 + RESUME_MAX_AGE_MS - 1)).toEqual(['a']);
    expect(await fileExists()).toBe(false);
  });

  it('arquivo mais velho que 10 min é ignorado e apagado mesmo assim', async () => {
    insertSession(db, { id: 'a', workspaceId: 'w1', agent: 'omp', title: 't', status: 'idle', createdAt: 1 });
    saveIdleSessionsForReload(db, home, 1_000);

    expect(takeResumeAfterReload(home, 1_000 + RESUME_MAX_AGE_MS + 1)).toEqual([]);
    expect(await fileExists()).toBe(false);
  });

  it('sem arquivo devolve lista vazia', () => {
    expect(takeResumeAfterReload(home, 1_000)).toEqual([]);
  });

  it('arquivo corrompido ou de formato errado é ignorado e apagado', async () => {
    await writeFile(fileOf(), '{não é json');
    expect(takeResumeAfterReload(home, 1_000)).toEqual([]);
    expect(await fileExists()).toBe(false);

    await writeFile(fileOf(), JSON.stringify({ savedAt: 'ontem', sessionIds: [1] }));
    expect(takeResumeAfterReload(home, 1_000)).toEqual([]);
    expect(await fileExists()).toBe(false);
  });
});

describe('resumeAfterReload', () => {
  interface CapturedLog {
    warns: Array<{ fields: object; message: string }>;
    infos: string[];
    warn(fields: object, message: string): void;
    info(fields: object, message: string): void;
  }

  function logOf(): CapturedLog {
    const log: CapturedLog = {
      warns: [],
      infos: [],
      warn(fields, message) {
        this.warns.push({ fields, message });
      },
      info(_fields, message) {
        this.infos.push(message);
      },
    };
    return log;
  }

  it('retoma cada sessão pelo resume existente', async () => {
    const resumed: string[] = [];
    const log = logOf();

    await resumeAfterReload(['a', 'b'], {
      resume: async (id) => {
        resumed.push(id);
        return { status: 'idle' };
      },
      log,
    });

    expect(resumed.sort()).toEqual(['a', 'b']);
    expect(log.warns).toEqual([]);
  });

  it('falha de uma sessão vira warn e não impede as outras', async () => {
    const resumed: string[] = [];
    const log = logOf();

    await resumeAfterReload(['ruim', 'boa'], {
      resume: async (id) => {
        if (id === 'ruim') throw new Error('agente sumiu');
        resumed.push(id);
        return { status: 'idle' };
      },
      log,
    });

    expect(resumed).toEqual(['boa']);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toMatchObject({ fields: { sessionId: 'ruim' } });
    expect(log.warns[0]?.message).toContain('não retomou');
  });

  it('agente que falha ao retomar (status error) também vira warn', async () => {
    const log = logOf();

    await resumeAfterReload(['a'], { resume: async () => ({ status: 'error' }), log });

    expect(log.warns).toHaveLength(1);
  });

  it('no máximo RESUME_CONCURRENCY retomadas ao mesmo tempo', async () => {
    expect(RESUME_CONCURRENCY).toBe(2);
    let inFlight = 0;
    let peak = 0;
    const ids = ['a', 'b', 'c', 'd', 'e'];

    await resumeAfterReload(ids, {
      resume: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: 'idle' };
      },
      log: logOf(),
    });

    expect(peak).toBe(2);
  });

  it('sem sessões não chama resume', async () => {
    let calls = 0;
    await resumeAfterReload([], {
      resume: async () => {
        calls += 1;
        return { status: 'idle' };
      },
      log: logOf(),
    });
    expect(calls).toBe(0);
  });
});
