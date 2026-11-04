import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMIT, acceptedCount, uploadFiles } from './attachments.js';

function file(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

describe('uploadFiles', () => {
  it('envia um por vez, na ordem, e devolve os infos na mesma ordem', async () => {
    const order: string[] = [];
    const infos = await uploadFiles(
      [file('a.png'), file('b.png')],
      async (item) => {
        order.push(item.name);
        return { fileId: `id-${item.name}`, name: item.name, mime: 'image/png', size: 1 };
      },
      () => undefined,
    );
    expect(order).toEqual(['a.png', 'b.png']);
    expect(infos.map((info) => info.fileId)).toEqual(['id-a.png', 'id-b.png']);
  });

  it('progresso agregado: cada arquivo pesa 1/n do total', async () => {
    const progress: number[] = [];
    await uploadFiles(
      [file('a.png'), file('b.png')],
      async (item, onProgress) => {
        onProgress(0.5);
        onProgress(1);
        return { fileId: item.name, name: item.name, mime: 'image/png', size: 1 };
      },
      (fraction) => progress.push(fraction),
    );
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('lista vazia não envia nada', async () => {
    let calls = 0;
    const infos = await uploadFiles(
      [],
      async () => {
        calls++;
        return { fileId: 'x', name: 'x', mime: 'image/png', size: 1 };
      },
      () => undefined,
    );
    expect(infos).toEqual([]);
    expect(calls).toBe(0);
  });

  it('falha no meio propaga o erro e não envia os seguintes', async () => {
    const sent: string[] = [];
    await expect(
      uploadFiles(
        [file('a.png'), file('b.png'), file('c.png')],
        async (item) => {
          sent.push(item.name);
          if (item.name === 'b.png') throw new Error('too_large');
          return { fileId: item.name, name: item.name, mime: 'image/png', size: 1 };
        },
        () => undefined,
      ),
    ).rejects.toThrow('too_large');
    expect(sent).toEqual(['a.png', 'b.png']);
  });
});

describe('acceptedCount', () => {
  it('limite de anexos por mensagem é 10 (mesmo máximo do prompt no WS)', () => {
    expect(ATTACHMENT_LIMIT).toBe(10);
  });

  it('aceita até o limite e corta o excedente', () => {
    expect(acceptedCount(0, 3)).toBe(3);
    expect(acceptedCount(8, 5)).toBe(2);
    expect(acceptedCount(10, 1)).toBe(0);
  });
});
