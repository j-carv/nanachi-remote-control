import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike, type XhrFactory, type XhrLike } from './api.js';

const FILE_INFO = { fileId: 'f-1', name: 'print final.png', mime: 'image/png', size: 3 };
const WORKSPACE = {
  id: 'w-1',
  name: 'app',
  path: 'C:\\projetos\\app',
  createdAt: 1_700_000_000_000,
  muted: true,
};

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** XMLHttpRequest falso: o teste dispara load, error e progresso à mão. */
class FakeXhr implements XhrLike {
  method = '';
  url = '';
  readonly headers: Record<string, string> = {};
  body: Blob | null = null;
  status = 0;
  responseText = '';
  readonly upload: XhrLike['upload'] = { onprogress: null };
  onload: XhrLike['onload'] = null;
  onerror: XhrLike['onerror'] = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: Blob): void {
    this.body = body;
  }
}

function fakeXhrFactory() {
  const created: FakeXhr[] = [];
  const createXhr: XhrFactory = () => {
    const xhr = new FakeXhr();
    created.push(xhr);
    return xhr;
  };
  return { created, createXhr };
}

function clientWith(fetchFn: FetchLike, createXhr?: XhrFactory) {
  return createApiClient(
    createXhr === undefined
      ? { baseUrl: 'http://127.0.0.1:7777/', token: 'tok-1' }
      : { baseUrl: 'http://127.0.0.1:7777/', token: 'tok-1', createXhr },
    fetchFn,
  );
}

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('esperava ApiError');
}

/** Dispara o load do XHR com status e corpo configurados. */
function finish(xhr: FakeXhr | undefined, status: number, body: unknown): void {
  if (xhr === undefined) throw new Error('XHR não criado');
  xhr.status = status;
  xhr.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  xhr.onload?.({ type: 'load' });
}

const NO_PROGRESS = () => undefined;

describe('uploadAttachment', () => {
  it('faz POST cru em /api/sessions/:id/attachments com X-File-Name codificado e o Content-Type', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const file = new File(['abc'], 'print final.png', { type: 'image/png' });
    const pending = clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
      's-1',
      file,
      NO_PROGRESS,
    );
    const xhr = created[0];
    expect(xhr?.method).toBe('POST');
    expect(xhr?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/attachments');
    expect(xhr?.headers['authorization']).toBe('Bearer tok-1');
    expect(xhr?.headers['X-File-Name']).toBe('print%20final.png');
    expect(xhr?.headers['content-type']).toBe('image/png');
    expect(xhr?.body).toBe(file);
    finish(xhr, 200, FILE_INFO);
    await pending;
  });

  it('arquivo sem tipo usa application/octet-stream', () => {
    const { created, createXhr } = fakeXhrFactory();
    void clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
      's-1',
      new File(['abc'], 'dados.bin'),
      NO_PROGRESS,
    );
    expect(created[0]?.headers['content-type']).toBe('application/octet-stream');
  });

  it('progresso do upload vira fração 0..1, só quando o total é conhecido', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const progress: number[] = [];
    const pending = clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
      's-1',
      new File(['abcd'], 'a.png', { type: 'image/png' }),
      (fraction) => progress.push(fraction),
    );
    const xhr = created[0];
    xhr?.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 });
    xhr?.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    xhr?.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
    expect(progress).toEqual([0.25, 1]);
    finish(xhr, 200, FILE_INFO);
    await pending;
  });

  it('200 devolve o arquivo validado pelo schema do shared', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const pending = clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
      's-1',
      new File(['abc'], 'a.png', { type: 'image/png' }),
      NO_PROGRESS,
    );
    finish(created[0], 200, FILE_INFO);
    expect(await pending).toEqual(FILE_INFO);
  });

  it('413 vira too_large (arquivo acima de 50 MB)', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const pending = errorOf(
      clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
        's-1',
        new File(['abc'], 'grande.mov'),
        NO_PROGRESS,
      ),
    );
    finish(created[0], 413, { error: 'too_large' });
    const error = await pending;
    expect(error.kind).toBe('too_large');
    expect(error.status).toBe(413);
  });

  it('401 vira unauthorized e 404 (sessão sumiu) vira not_found', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const client = clientWith(fakeFetch(() => json({})).fetchFn, createXhr);

    const unauthorized = errorOf(client.uploadAttachment('s-1', new File(['a'], 'a'), NO_PROGRESS));
    finish(created[0], 401, { error: 'unauthorized' });
    expect((await unauthorized).kind).toBe('unauthorized');

    const missing = errorOf(client.uploadAttachment('s-2', new File(['a'], 'a'), NO_PROGRESS));
    finish(created[1], 404, { error: 'not_found' });
    expect((await missing).kind).toBe('not_found');
  });

  it('falha de rede (onerror) vira network sem status', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const pending = errorOf(
      clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
        's-1',
        new File(['a'], 'a'),
        NO_PROGRESS,
      ),
    );
    created[0]?.onerror?.({ type: 'error' });
    const error = await pending;
    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
  });

  it('200 com corpo fora do schema vira unexpected', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const pending = errorOf(
      clientWith(fakeFetch(() => json({})).fetchFn, createXhr).uploadAttachment(
        's-1',
        new File(['a'], 'a'),
        NO_PROGRESS,
      ),
    );
    finish(created[0], 200, { fileId: '' });
    expect((await pending).kind).toBe('unexpected');
  });

  it('sessionId vazio é invalid_input e nem abre a conexão', async () => {
    const { created, createXhr } = fakeXhrFactory();
    const client = clientWith(fakeFetch(() => json({})).fetchFn, createXhr);
    const error = await errorOf(client.uploadAttachment('', new File(['a'], 'a'), NO_PROGRESS));
    expect(error.kind).toBe('invalid_input');
    expect(created).toHaveLength(0);
  });
});

describe('fetchFileBlob', () => {
  it('faz GET /api/files/:id com Bearer e devolve o conteúdo como Blob', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response('PNG', { status: 200 }));
    const blob = await clientWith(fetchFn).fetchFileBlob('f/1', 'image/png');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/files/f%2F1');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1');
    expect(await blob.text()).toBe('PNG');
    expect(blob.type).toBe('image/png');
  });

  it('o Blob leva o tipo do cliente só para raster inline; HTML vira application/octet-stream mesmo se o servidor mandar text/html', async () => {
    const html = fakeFetch(() => new Response('<script>x</script>', { headers: { 'content-type': 'text/html' } }));
    const blob = await clientWith(html.fetchFn).fetchFileBlob('f-1', 'text/html');
    expect(blob.type).toBe('application/octet-stream');
  });

  it('404 vira not_found', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_found' }, 404));
    expect((await errorOf(clientWith(fetchFn).fetchFileBlob('f-1', 'image/png'))).kind).toBe('not_found');
  });

  it('id vazio nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response('x'));
    expect((await errorOf(clientWith(fetchFn).fetchFileBlob('', 'image/png'))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('updateWorkspace', () => {
  it('faz PATCH em /api/workspaces/:id com { muted } e devolve o workspace', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(WORKSPACE));
    expect(await clientWith(fetchFn).updateWorkspace('w-1', { muted: true })).toEqual(WORKSPACE);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/workspaces/w-1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ muted: true });
  });

  it('muted que não é booleano nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(WORKSPACE));
    const bad = { muted: 'sim' } as unknown as { muted: boolean };
    expect((await errorOf(clientWith(fetchFn).updateWorkspace('w-1', bad))).kind).toBe(
      'invalid_input',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('push', () => {
  const PUBLIC_KEY =
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
  const SUBSCRIPTION = {
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: 'p256', auth: 'auth' },
  };

  it('getPushKey faz GET /api/push/key e devolve a chave pública', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ publicKey: PUBLIC_KEY }));
    expect(await clientWith(fetchFn).getPushKey()).toBe(PUBLIC_KEY);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/push/key');
  });

  it('getPushKey com corpo fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ key: 'x' }));
    expect((await errorOf(clientWith(fetchFn).getPushKey())).kind).toBe('unexpected');
  });

  it('subscribePush faz POST /api/push/subscribe com endpoint e chaves', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).subscribePush(SUBSCRIPTION);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/push/subscribe');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(SUBSCRIPTION);
  });

  it('subscribePush com endpoint que não é URL nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    const bad = { ...SUBSCRIPTION, endpoint: 'nao-e-url' };
    expect((await errorOf(clientWith(fetchFn).subscribePush(bad))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('unsubscribePush faz DELETE /api/push/subscribe com o endpoint no corpo', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).unsubscribePush(SUBSCRIPTION.endpoint);
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/push/subscribe');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ endpoint: SUBSCRIPTION.endpoint });
  });

  it('unsubscribePush com 500 vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 500));
    expect((await errorOf(clientWith(fetchFn).unsubscribePush(SUBSCRIPTION.endpoint))).kind).toBe(
      'unexpected',
    );
  });
});
