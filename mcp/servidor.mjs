#!/usr/bin/env node
// WA5 MCP server.
//
// Gives an agent (Hermes) four tools over the accounts open in the app: list
// accounts, list pending chats, read a conversation and LEAVE A DRAFT written
// in the message box. There is deliberately no send tool: the Enter is pressed
// by the person.
//
// It talks to the local control server the app exposes on 127.0.0.1.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTROL_FILE = path.join(
  os.homedir(), 'Library', 'Application Support', 'WA5', 'control.json'
);

function readControl() {
  try {
    const j = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    // "port" is the current key; "puerto" is read so a control.json written
    // before the rename keeps working.
    if (j && j.token) return { token: j.token, port: j.port || j.puerto || 5077 };
  } catch { /* explained below */ }
  throw new Error(
    `Cannot find ${CONTROL_FILE}. Open WA5 at least once so it generates the control token.`
  );
}

async function request(pathname, { method = 'GET', body } = {}) {
  const { token, port } = readControl();
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'x-token': token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await r.json().catch(() => ({ ok: false, error: 'non-JSON response' }));
  if (!data.ok) {
    throw new Error(
      data.error === 'invalid token'
        ? 'The app rejected the token. Quit and reopen WA5 to regenerate it.'
        : data.error || `error ${r.status}`
    );
  }
  return data;
}

const asText = (t) => ({ content: [{ type: 'text', text: t }] });
const asError = (e) => ({ isError: true, content: [{ type: 'text', text: 'Failed: ' + e.message }] });

const server = new McpServer({ name: 'wa5', version: '1.0.0' });

server.tool(
  'wa5_accounts',
  'Lists the WhatsApp accounts open in the WA5 app, with their unread counts and whether they have loaded. Call this first to learn which accounts exist.',
  {},
  async () => {
    try {
      const d = await request('/state');
      // The state object is built by main.js; both spellings are read so this
      // server keeps working while that file is translated separately.
      const accounts = d.data.accounts || d.data.cuentas || [];
      const lines = accounts.map(a =>
        `- ${a.name ?? a.nombre} (id ${a.id}): ${a.unread ?? a.noLeidos ?? 0} unread, state ${a.loadState ?? a.load ?? a.carga ?? 'unknown'}`
      );
      return asText(`Accounts open in WA5:\\n${lines.join('\\n')}`);
    } catch (e) { return asError(e); }
  }
);

server.tool(
  'wa5_pending',
  'Returns the chats that have unread messages in one account: who wrote, what they said last and at what time. Use it to find out who is waiting for an answer.',
  {
    account: z.string().optional().describe('Account name or id. Defaults to the first one.'),
    all: z.boolean().optional().describe('When true, returns every chat, not only the ones with unread messages.')
  },
  async ({ account, all }) => {
    try {
      const q = new URLSearchParams();
      if (account) q.set('account', account);
      if (all) q.set('all', '1');
      const d = await request('/pending?' + q.toString());
      if (!d.chats.length) return asText(`Nothing pending in ${d.account}.`);
      const lines = d.chats.map(c =>
        `- ${c.chat}${c.unread ? ` [${c.unread} unread]` : ''}${c.time ? ` (${c.time})` : ''}: ${c.lastMessage || '(no preview)'}`
      );
      return asText(`Pending in ${d.account} (${d.total}):\\n${lines.join('\\n')}`);
    } catch (e) { return asError(e); }
  }
);

server.tool(
  'wa5_read',
  'Opens a conversation and returns its latest messages, saying who sent each one and at what time. Note: reading a chat marks it as read in WhatsApp.',
  {
    chat: z.string().describe('Exact or partial name of the chat or contact.'),
    account: z.string().optional().describe('Account name or id. Defaults to the first one.'),
    n: z.number().int().min(1).max(100).optional().describe('How many messages to return (20 by default).')
  },
  async ({ chat, account, n }) => {
    try {
      const q = new URLSearchParams({ chat });
      if (account) q.set('account', account);
      if (n) q.set('n', String(n));
      const d = await request('/read?' + q.toString());
      const lines = d.messages.map(m =>
        `[${m.time || '--:--'}] ${m.from === 'me' ? 'Me' : m.from}: ${m.text || '(no text)'}`
      );
      return asText(`Conversation with ${d.chat} (${d.account}), last ${d.messages.length}:\\n${lines.join('\\n')}`);
    } catch (e) { return asError(e); }
  }
);

server.tool(
  'wa5_draft',
  'Writes a text as a DRAFT in the message box of a conversation, without sending it. It leaves the chat open so the person can review it and send it with Enter. There is no way to send from here.',
  {
    chat: z.string().describe('Exact or partial name of the chat or contact.'),
    text: z.string().min(1).max(4000).describe('The message to leave written.'),
    account: z.string().optional().describe('Account name or id. Defaults to the first one.')
  },
  async ({ chat, text, account }) => {
    try {
      const q = new URLSearchParams();
      if (account) q.set('account', account);
      const d = await request('/draft?' + q.toString(), { method: 'POST', body: { chat, text } });
      return asText(
        `Draft written in the conversation with ${d.chat} (${d.account}). It was NOT sent.\\n` +
        `The box now reads: "${d.written}"\\n` +
        `Press Enter in the app when you want to send it (or delete it if you don't like it).`
      );
    } catch (e) { return asError(e); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
