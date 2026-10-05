// lib/mcp/server.js — the Model Context Protocol, as much of it as Onyx
// needs: a stateless Streamable HTTP server that answers each JSON-RPC
// message on its own (no sessions, no server-sent events), offering the
// tools in lib/mcp/tools.js. app/api/mcp/route.js is the transport and the
// door (who is calling); this is what is said once they are in.

import { TOOLS, listTools, ToolError } from './tools.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'onyx', title: 'Onyx', version: '1.0.0' };

const INSTRUCTIONS = [
  'Onyx is a media library: files in drives and folders, with tags, metadata fields, review comments and share links.',
  'Everything is in drives: start with onyx_list_drives, then search or browse one. Ids from one result are what the next tool takes.',
  'Files under a folder also count as carrying the folder\'s tags and metadata in collections.',
  'Nothing here deletes. Changes are made as the person who connected Onyx, with their access.',
].join(' ');

const byName = new Map(TOOLS.map((t) => [t.name, t]));

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** The text and structured content of a tool's result. */
function asResult(out) {
  if (out && Array.isArray(out.content)) return out;
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
}

/**
 * One JSON-RPC message, answered. `ctx` is { call, origin } (lib/mcp/
 * tools.js). Resolves the response object, or null for a notification.
 */
export async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return failure(msg?.id, -32600, 'Invalid request');
  }
  const { id, method, params } = msg;
  const notification = id === undefined || id === null;
  if (notification) return null; // notifications/initialized, cancelled, …: nothing to say

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: listTools() });
    case 'tools/call': {
      const tool = byName.get(params?.name);
      if (!tool) return failure(id, -32602, `Unknown tool: ${params?.name}`);
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        return reply(id, asResult(await tool.run(args, ctx)));
      } catch (e) {
        // A refusal or a missing preview is the tool's answer, for the model
        // to read and act on; anything else is logged and said plainly.
        if (!(e instanceof ToolError)) console.warn(`[mcp] ${tool.name} failed:`, e?.message);
        const text = e instanceof ToolError ? e.message : 'Onyx could not do that just now. Try again in a moment.';
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/** A POST body: one message or a batch. Resolves what to answer, or null for 202. */
export async function handleBody(body, ctx) {
  if (Array.isArray(body)) {
    if (!body.length) return failure(null, -32600, 'Empty batch');
    const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMessage(body, ctx);
}
