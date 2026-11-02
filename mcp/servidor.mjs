#!/usr/bin/env node
// Servidor MCP de WA5.
//
// Le da a un agente (Hermes) cuatro herramientas sobre las cuentas abiertas en
// la app: ver cuentas, ver pendientes, leer una conversación y DEJAR UN BORRADOR
// escrito en la caja de texto. No existe herramienta de envío a propósito: el
// Enter lo da la persona.
//
// Habla con el servidor de control local que expone la app en 127.0.0.1.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUTA_CONTROL = path.join(
  os.homedir(), 'Library', 'Application Support', 'WA5', 'control.json'
);

function leerControl() {
  try {
    const j = JSON.parse(fs.readFileSync(RUTA_CONTROL, 'utf8'));
    if (j && j.token) return { token: j.token, puerto: j.puerto || 5077 };
  } catch { /* abajo se explica */ }
  throw new Error(
    `No encuentro ${RUTA_CONTROL}. Abre WA5 al menos una vez para que genere el token de control.`
  );
}

async function pedir(ruta, { metodo = 'GET', cuerpo } = {}) {
  const { token, puerto } = leerControl();
  const r = await fetch(`http://127.0.0.1:${puerto}${ruta}`, {
    method: metodo,
    headers: {
      'x-token': token,
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {})
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const datos = await r.json().catch(() => ({ ok: false, error: 'respuesta no JSON' }));
  if (!datos.ok) {
    throw new Error(
      datos.error === 'token inválido'
        ? 'La app rechazó el token. Cierra y abre WA5 para regenerarlo.'
        : datos.error || `error ${r.status}`
    );
  }
  return datos;
}

const texto = (t) => ({ content: [{ type: 'text', text: t }] });
const fallo = (e) => ({ isError: true, content: [{ type: 'text', text: 'No se pudo: ' + e.message }] });

const servidor = new McpServer({ name: 'wa5', version: '1.0.0' });

servidor.tool(
  'wa5_cuentas',
  'Lista las cuentas de WhatsApp abiertas en la app WA5, con sus mensajes sin leer y si ya cargaron. Úsala primero para saber qué cuentas existen.',
  {},
  async () => {
    try {
      const d = await pedir('/estado');
      const lineas = d.datos.cuentas.map(c =>
        `- ${c.nombre} (id ${c.id}): ${c.noLeidos} sin leer, estado ${c.carga}`
      );
      return texto(`Cuentas abiertas en WA5:\n${lineas.join('\n')}`);
    } catch (e) { return fallo(e); }
  }
);

servidor.tool(
  'wa5_pendientes',
  'Devuelve los chats que tienen mensajes sin leer en una cuenta: quién escribió, qué dijo por última vez y a qué hora. Sirve para saber a quién hay que responderle.',
  {
    cuenta: z.string().optional().describe('Nombre o id de la cuenta. Si se omite, usa la primera.'),
    todos: z.boolean().optional().describe('Si es true, devuelve todos los chats y no solo los que tienen mensajes sin leer.')
  },
  async ({ cuenta, todos }) => {
    try {
      const q = new URLSearchParams();
      if (cuenta) q.set('cuenta', cuenta);
      if (todos) q.set('todos', '1');
      const d = await pedir('/pendientes?' + q.toString());
      if (!d.chats.length) return texto(`Sin pendientes en ${d.cuenta}.`);
      const lineas = d.chats.map(c =>
        `- ${c.chat}${c.noLeidos ? ` [${c.noLeidos} sin leer]` : ''}${c.hora ? ` (${c.hora})` : ''}: ${c.ultimo || '(sin vista previa)'}`
      );
      return texto(`Pendientes en ${d.cuenta} (${d.total}):\n${lineas.join('\n')}`);
    } catch (e) { return fallo(e); }
  }
);

servidor.tool(
  'wa5_leer',
  'Abre una conversación y devuelve sus últimos mensajes, indicando quién los mandó y la hora. Ojo: leer un chat lo marca como leído en WhatsApp.',
  {
    chat: z.string().describe('Nombre exacto o parcial del chat o contacto.'),
    cuenta: z.string().optional().describe('Nombre o id de la cuenta. Si se omite, usa la primera.'),
    n: z.number().int().min(1).max(100).optional().describe('Cuántos mensajes devolver (por omisión 20).')
  },
  async ({ chat, cuenta, n }) => {
    try {
      const q = new URLSearchParams({ chat });
      if (cuenta) q.set('cuenta', cuenta);
      if (n) q.set('n', String(n));
      const d = await pedir('/leer?' + q.toString());
      const lineas = d.mensajes.map(m =>
        `[${m.hora || '--:--'}] ${m.de === 'yo' ? 'Yo' : m.de}: ${m.texto || '(sin texto)'}`
      );
      return texto(`Conversación con ${d.chat} (${d.cuenta}), últimos ${d.mensajes.length}:\n${lineas.join('\n')}`);
    } catch (e) { return fallo(e); }
  }
);

servidor.tool(
  'wa5_borrador',
  'Escribe un texto como BORRADOR en la caja de mensaje de una conversación, sin enviarlo. Deja el chat abierto para que la persona lo revise y lo mande con Enter. No existe forma de enviar desde aquí.',
  {
    chat: z.string().describe('Nombre exacto o parcial del chat o contacto.'),
    texto: z.string().min(1).max(4000).describe('El mensaje a dejar escrito.'),
    cuenta: z.string().optional().describe('Nombre o id de la cuenta. Si se omite, usa la primera.')
  },
  async ({ chat, texto: cuerpo, cuenta }) => {
    try {
      const q = new URLSearchParams();
      if (cuenta) q.set('cuenta', cuenta);
      const d = await pedir('/borrador?' + q.toString(), { metodo: 'POST', cuerpo: { chat, texto: cuerpo } });
      return texto(
        `Borrador escrito en la conversación con ${d.chat} (${d.cuenta}). NO se envió.\n` +
        `En la caja quedó: "${d.escrito}"\n` +
        `Dale Enter en la app cuando quieras mandarlo (o bórralo si no te gusta).`
      );
    } catch (e) { return fallo(e); }
  }
);

const transporte = new StdioServerTransport();
await servidor.connect(transporte);
