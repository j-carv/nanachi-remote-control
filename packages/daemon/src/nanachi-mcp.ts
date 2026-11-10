import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ASK_USER_TIMEOUT_MS, AskUserInputSchema, AskUserResultSchema, PhoneSendToolInputSchema,
  REQUEST_FILE_TIMEOUT_MS, RequestFileInputSchema, RequestFileAgentResultSchema,
  PreviewInputSchema, PreviewInfoSchema, type AskUserResult, type RequestFileAgentResult,
  MemoryToolResponseSchema, MemoryToolInputSchema,
} from '@nanachi/shared';
import { runPhoneSend, type PhoneSendDeps } from './phone-send.js';

/** ACP v1 stdio has no `type`. Credentials belong to this process, never to a tool argument. */
export function nanachiMcpDescriptor(env: NodeJS.ProcessEnv, workspace: string): acp.McpServerStdio {
  const source = import.meta.url.endsWith('.ts');
  const script = fileURLToPath(new URL(source ? './nanachi-mcp.ts' : './nanachi-mcp.js', import.meta.url));
  // Like the fake-agent launcher, resolve the source loader absolutely: the child's cwd is the workspace.
  const args = source
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href, script]
    : [script];
  return {
    name: 'nanachi-remote',
    command: process.execPath,
    args,
    env: [
      ...['AGENT_SESSION_ID', 'NANACHI_URL', 'NANACHI_AGENT_TOKEN'].map((name) => {
        const value = env[name];
        if (!value) throw new Error(`Nanachi MCP: missing ${name}`);
        return { name, value };
      }),
      { name: 'NANACHI_WORKSPACE', value: workspace },
    ],
  };
}

/** The CLI and MCP share the upload, screenshot, size checks and session authentication implementation. */
export function createNanachiMcpServer(env: NodeJS.ProcessEnv, deps?: PhoneSendDeps): McpServer {
  const server = new McpServer({ name: 'nanachi-remote', version: '1.0.0' });
  server.registerTool('phone_send', {
    description: 'Send a file or a screenshot from this PC to the user\'s phone in the current Nanachi session. Provide exactly one of path or screenshot: true, with an optional caption.',
    inputSchema: PhoneSendToolInputSchema,
  }, async (input) => {
    const messages: string[] = [];
    try {
      const workspace = env.NANACHI_WORKSPACE;
      if (!workspace) {
        return { isError: true, content: [{ type: 'text', text: 'Nanachi MCP: missing session workspace' }] };
      }
      const argv = input.path !== undefined
        ? [resolve(workspace, input.path)]
        : ['--screenshot'];
      if (input.caption !== undefined) argv.push('--caption', input.caption);
      const code = await runPhoneSend(argv, env, {
        out: (line) => messages.push(line),
        err: (line) => messages.push(line),
      }, deps);
      return { isError: code !== 0, content: [{ type: 'text', text: messages.join('\n') }] };
    } catch {
      // Do not expose exception details that could contain transport headers or credentials.
      return { isError: true, content: [{ type: 'text', text: 'Nanachi MCP: failed to send file' }] };
    }
  });
  server.registerTool('ask_user', {
    description: 'Ask the user a question with 2–8 explicit option buttons in the current Nanachi phone chat, and wait for their exact choice without ending the turn. Only status "answered" is a user decision. Cancellation, expiry, disconnect, errors and missing answers NEVER mean approval or permission; do not continue an action that requires a user decision. This is not a security permission approval tool.',
    inputSchema: AskUserInputSchema,
  }, async (input, extra) => {
    const resultOf = (result: AskUserResult, isError = false) => ({
      isError,
      structuredContent: result,
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    });
    const sessionId = env.AGENT_SESSION_ID;
    const baseUrl = env.NANACHI_URL;
    const token = env.NANACHI_AGENT_TOKEN;
    if (!sessionId || !baseUrl || !token) {
      return resultOf({ status: 'cancelled', reason: 'disconnected' }, true);
    }
    // Leave the daemon time to persist and return its five-minute expiry before a hard transport deadline.
    const timeout = AbortSignal.timeout(ASK_USER_TIMEOUT_MS + 15_000);
    const signal = AbortSignal.any([extra.signal, timeout]);
    try {
      const response = await (deps?.fetch ?? globalThis.fetch)(`${baseUrl}/api/agent/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Nanachi-Session': sessionId,
          'X-Nanachi-Agent-Token': token,
        },
        body: JSON.stringify({ ...input, requestId: randomUUID() }),
        redirect: 'error',
        signal,
      });
      if (!response.ok) return resultOf({ status: 'cancelled', reason: 'disconnected' }, true);
      const parsed = AskUserResultSchema.safeParse(await response.json());
      if (!parsed.success || signal.aborted) {
        return resultOf({ status: 'cancelled', reason: timeout.aborted ? 'expired' : 'disconnected' }, true);
      }
      return resultOf(parsed.data, parsed.data.status !== 'answered');
    } catch {
      // Never include transport errors or URLs: either can contain session credentials.
      return resultOf({ status: 'cancelled', reason: timeout.aborted ? 'expired' : 'disconnected' }, true);
    }
  });
  server.registerTool('request_file', {
    description: 'Ask the user to explicitly choose and send one file from their phone in this Nanachi session, and wait without ending the turn. Optional accept filters are MIME types, subtype wildcards such as image/*, or extensions such as .pdf. Only status "received" supplies a real stored absolute path; uploads alone, cancellation, expiry and errors NEVER supply a file or approval. This does not submit another user prompt.',
    inputSchema: RequestFileInputSchema,
  }, async (input, extra) => {
    const resultOf = (result: RequestFileAgentResult, isError = false) => ({
      isError,
      structuredContent: result,
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    });
    const sessionId = env.AGENT_SESSION_ID;
    const baseUrl = env.NANACHI_URL;
    const token = env.NANACHI_AGENT_TOKEN;
    if (!sessionId || !baseUrl || !token) {
      return resultOf({ status: 'cancelled', reason: 'disconnected' }, true);
    }
    const timeout = AbortSignal.timeout(REQUEST_FILE_TIMEOUT_MS + 15_000);
    const signal = AbortSignal.any([extra.signal, timeout]);
    try {
      const response = await (deps?.fetch ?? globalThis.fetch)(`${baseUrl}/api/agent/file-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Nanachi-Session': sessionId,
          'X-Nanachi-Agent-Token': token,
        },
        body: JSON.stringify({ ...input, requestId: randomUUID() }),
        redirect: 'error',
        signal,
      });
      if (!response.ok) return resultOf({ status: 'cancelled', reason: 'disconnected' }, true);
      const parsed = RequestFileAgentResultSchema.safeParse(await response.json());
      if (!parsed.success || signal.aborted) {
        return resultOf({ status: 'cancelled', reason: timeout.aborted ? 'expired' : 'disconnected' }, true);
      }
      return resultOf(parsed.data, parsed.data.status !== 'received');
    } catch {
      return resultOf({ status: 'cancelled', reason: timeout.aborted ? 'expired' : 'disconnected' }, true);
    }
  });
  server.registerTool('open_preview', {
    description: 'Create a preview card for an already-running local HTTP development server port in the current Nanachi chat. The user must explicitly tap Open to view it; this tool does not open a browser automatically. Previews use a separate origin from Nanachi and expire. One preview is active per browser profile/PC at a time. Provide only the local port, optional title and local rooted path; never a hostname, public URL or credentials.',
    inputSchema: PreviewInputSchema,
  }, async (input, extra) => {
    const failed = () => ({
      isError: true,
      content: [{ type: 'text' as const, text: 'Nanachi MCP: preview could not be created. Check that the local HTTP server is running and retry during an active turn.' }],
    });
    const sessionId = env.AGENT_SESSION_ID;
    const baseUrl = env.NANACHI_URL;
    const token = env.NANACHI_AGENT_TOKEN;
    if (!sessionId || !baseUrl || !token) return failed();
    const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(15_000)]);
    try {
      const response = await (deps?.fetch ?? globalThis.fetch)(`${baseUrl}/api/agent/previews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Nanachi-Session': sessionId,
          'X-Nanachi-Agent-Token': token,
        },
        body: JSON.stringify(input),
        redirect: 'error',
        signal,
      });
      if (!response.ok) return failed();
      const parsed = PreviewInfoSchema.safeParse(await response.json());
      if (!parsed.success || signal.aborted) return failed();
      return {
        isError: false,
        structuredContent: parsed.data,
        content: [{ type: 'text' as const, text: JSON.stringify(parsed.data) }],
      };
    } catch {
      // Never echo transport details or server bodies: they can contain credentials or private paths.
      return failed();
    }
  });
  for (const kind of ['memory', 'skill'] as const) {
    server.registerTool(kind === 'memory' ? 'memory' : 'skills', {
      description: `Explicitly search, read, save or forget global ${kind === 'memory' ? 'memories' : 'procedural skills'} shared across this Nanachi installation's workspaces. Each result reports the current workspace automatically from your authenticated session; each entry's sourceWorkspace identifies its origin, not an access restriction. No workspace selection is needed. Keep project-specific facts associated with their origin rather than treating them as universal preferences. Retrieval happens only through this tool, never automatic prompt injection. Saves use the latest user message as evidence by default; optional evidenceSeqs must identify authentic events from this session. Updates and forgetting require the last observed expectedVersion; approval may be required. Never store credentials. Session identity and workspace context cannot be overridden by tool arguments.`,
      inputSchema: MemoryToolInputSchema,
    }, async (input, extra) => {
      const failed = () => ({
        isError: true,
        content: [{ type: 'text' as const, text: 'Nanachi MCP: memory operation failed. Learning and this agent’s Nanachi MCP must be enabled; use valid session evidence and the current entry version.' }],
      });
      const sessionId = env.AGENT_SESSION_ID;
      const baseUrl = env.NANACHI_URL;
      const token = env.NANACHI_AGENT_TOKEN;
      if (!sessionId || !baseUrl || !token) return failed();
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(15_000)]);
      try {
        const response = await (deps?.fetch ?? globalThis.fetch)(`${baseUrl}/api/agent/memory`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Nanachi-Session': sessionId, 'X-Nanachi-Agent-Token': token },
          body: JSON.stringify({ kind, input }),
          redirect: 'error',
          signal,
        });
        if (!response.ok) return failed();
        const text = await response.text();
        if (text.length > 1_000_000) return failed();
        const parsed = MemoryToolResponseSchema.safeParse(JSON.parse(text));
        if (!parsed.success || parsed.data.entries.length > 40 || signal.aborted) return failed();
        return {
          isError: false,
          structuredContent: parsed.data,
          content: [{ type: 'text' as const, text: JSON.stringify(parsed.data) }],
        };
      } catch {
        return failed();
      }
    });
  }
  return server;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  createNanachiMcpServer(process.env).connect(new StdioServerTransport()).catch(() => {
    console.error('Nanachi MCP: stdio connection failed');
    process.exitCode = 1;
  });
}
