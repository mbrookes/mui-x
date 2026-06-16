/**
 * Integration tests for buildStudioMcpServer over real HTTP transport.
 *
 * These tests spin up a minimal Node.js HTTP server that mirrors the Express
 * integration in examples/x-studio-dev-server/src/routes/mcp.ts, then connect
 * a real MCP Client via StreamableHTTPClientTransport to exercise the full
 * request/response cycle — tool listing, resource reads, tool calls, and prompts.
 *
 * Run with:
 *   pnpm --filter "@mui/x-studio-ai-middleware" run test:integration --run
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildStudioMcpServer } from '../mcp.js';
import type { StudioStateBox } from '../mcp.js';
import { createDefaultStudioState } from '../models/studioTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ── Test server setup ─────────────────────────────────────────────────────────

let httpServer: http.Server;
let serverPort: number;
let client: Client;

const transports: Record<string, StreamableHTTPServerTransport> = {};
const stateBoxes: Record<string, StudioStateBox> = {};

beforeAll(async () => {
  httpServer = http.createServer(async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (req.method === 'POST') {
        const body = await readBody(req);

        if (sessionId && transports[sessionId]) {
          await transports[sessionId].handleRequest(req, res, body);
          return;
        }

        if (!sessionId && isInitializeRequest(body)) {
          const stateBox: StudioStateBox = { current: createDefaultStudioState() };
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport;
              stateBoxes[sid] = stateBox;
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              delete transports[sid];
              delete stateBoxes[sid];
            }
          };
          const mcpServer = buildStudioMcpServer(stateBox);
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request' },
            id: null,
          }),
        );
      } else if (req.method === 'GET') {
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400).end('Missing or invalid Mcp-Session-Id header.');
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else if (req.method === 'DELETE') {
        if (!sessionId || !transports[sessionId]) {
          res.writeHead(400).end('Missing or invalid Mcp-Session-Id header.');
          return;
        }
        await transports[sessionId].handleRequest(req, res);
      } else {
        res.writeHead(405).end('Method Not Allowed');
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500).end(String(err));
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  serverPort = (httpServer.address() as net.AddressInfo).port;

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${serverPort}/`));
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP server — tools', () => {
  it('exposes expected dashboard tools via HTTP', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_dashboard_state');
    expect(names).toContain('add_page');
    expect(names).toContain('add_widget');
    expect(names).toContain('update_widget');
    expect(names).toContain('set_dashboard_title');
  });

  it('excludes server-side-only tools by default', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('summarise_page');
    expect(names).not.toContain('execute_query');
  });
});

describe('MCP server — resources', () => {
  it('lists static resources', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('studio://dashboard/state');
    expect(uris).toContain('studio://dashboard/system-prompt');
  });

  it('reads the dashboard state resource as valid JSON', async () => {
    const result = await client.readResource({ uri: 'studio://dashboard/state' });
    const contents = result.contents as Array<{ text: string; mimeType: string }>;
    expect(contents[0].mimeType).toBe('application/json');
    const state = JSON.parse(contents[0].text);
    expect(state).toHaveProperty('dashboard');
    expect(state).toHaveProperty('pages');
    expect(state).toHaveProperty('widgets');
  });

  it('reads the system-prompt resource as plain text', async () => {
    const result = await client.readResource({ uri: 'studio://dashboard/system-prompt' });
    const contents = result.contents as Array<{ text: string; mimeType: string }>;
    expect(contents[0].mimeType).toBe('text/plain');
    expect(typeof contents[0].text).toBe('string');
    expect(contents[0].text.length).toBeGreaterThan(0);
  });
});

describe('MCP server — tool calls', () => {
  it('get_dashboard_state returns the AI system prompt text', async () => {
    const result = await client.callTool({ name: 'get_dashboard_state', arguments: {} });
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content.type).toBe('text');
    // Response is { output: "<system prompt text>" }
    const response = JSON.parse(content.text);
    expect(typeof response.output).toBe('string');
    expect(response.output.length).toBeGreaterThan(0);
  });

  it('add_page reports success and mutation, page appears in state resource', async () => {
    const result = await client.callTool({
      name: 'add_page',
      arguments: { title: 'Integration Test Page' },
    });
    const content = (result.content as Array<{ type: string; text: string }>)[0];
    expect(content.type).toBe('text');
    // Response is { output: '{"success":true,"pageId":"...","title":"..."}', mutation: {...} }
    const response = JSON.parse(content.text);
    const output = JSON.parse(response.output);
    expect(output.success).toBe(true);
    expect(output.title).toBe('Integration Test Page');
    expect(response.mutation.type).toBe('addPage');
  });

  it('state resource reflects mutations from tool calls', async () => {
    await client.callTool({
      name: 'set_dashboard_title',
      arguments: { title: 'My Integration Dashboard' },
    });
    const result = await client.readResource({ uri: 'studio://dashboard/state' });
    const contents = result.contents as Array<{ text: string }>;
    const state = JSON.parse(contents[0].text);
    expect(state.dashboard.title).toBe('My Integration Dashboard');
  });
});

describe('MCP server — prompts', () => {
  it('lists the query_data_source_examples prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('query_data_source_examples');
  });

  it('getPrompt returns message templates', async () => {
    const result = await client.getPrompt({ name: 'query_data_source_examples' });
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages[0].role).toBe('user');
  });
});
