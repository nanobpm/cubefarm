// The ACP runtime: the CEO on a coding agent spoken to over ACP (Agent Client Protocol: `<cli> --acp`, JSON-RPC over
// stdio), e.g. nano-coder or GitHub Copilot CLI. Same session contract as agentRunner.ts and cliRunner.ts. The
// office tools reach it as a shell command (acp.ts), since not every harness takes MCP servers.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CeoHarness } from '../shared/types.ts';
import { ACP_COMMANDS, acpArgs, additionalDirectories, OFFICE_COMMAND_SOURCE, parseRpc, permissionOutcome, readUpdate, withTimeout, type AcpCapabilities, type RpcMessage } from './acp.ts';
import type { SessionCallbacks, SessionHandle, SessionOptions, SessionResult } from './agentRunner.ts';
import type { OfficeTools } from './ceo.ts';
import { officeAddress } from './cliRunner.ts';
import { programFor } from './clis.ts';
import { HOME_DIR } from './config.ts';
import { killTree } from './deps.ts';

const OFFICE_COMMAND = path.join(HOME_DIR, 'bin', 'cubefarm-office.cjs');

/** Startup (initialize/session/new/load) must answer within this, or the child is killed and its stderr reported. */
export const ACP_STARTUP_TIMEOUT_MS = 60_000;

/** The shell command the CEO's instructions give it for the office tools. Forward slashes: it may run in Git Bash. */
export function officeCommand(): string {
  return `node "${OFFICE_COMMAND.replaceAll('\\', '/')}"`;
}

// ---------- the office tools over HTTP ----------

const offices = new Map<string, OfficeTools>();

/** A tool call from the office command (POST /api/office/:token/:tool): the answer text, or the office's refusal. */
export async function handleOfficeCall(token: string, tool: string, body: unknown): Promise<{ text?: string; error?: string }> {
  const office = offices.get(token);
  if (!office) return { error: 'This CEO session has ended.' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: `The arguments for ${tool} must be a JSON object, e.g. '{}'.` };
  try {
    const text = await office.call(tool, body as Record<string, unknown>);
    return text.startsWith('Refused: ') ? { error: text.slice('Refused: '.length) } : { text };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ---------- a session ----------

/** The CEO's first prompt carries its instructions: ACP has no system prompt of its own. */
export function firstPrompt(opts: Pick<SessionOptions, 'prompt' | 'systemAppend'>): string {
  return `${opts.systemAppend}\n\n---\n\n${opts.prompt}`;
}

export function startAcpSession(harness: Exclude<CeoHarness, 'claude'>, opts: SessionOptions, cb: SessionCallbacks): SessionHandle {
  const token = randomUUID();
  if (opts.office) offices.set(token, opts.office);
  let finished = false;
  let turns = 0;
  const errors: string[] = [];
  let lastText = '';
  const queue: string[] = [];
  let prompting = false;
  let sessionId: string | null = null;
  let stderrTail = '';
  let child: ChildProcessWithoutNullStreams | null = null;

  const finish = (r: Omit<SessionResult, 'costUsd' | 'turns'>) => {
    if (finished) return;
    finished = true;
    offices.delete(token);
    cb.tool(null);
    if (child) void killTree(child);
    cb.finished({ ...r, costUsd: 0, turns });
  };

  const program = programFor(ACP_COMMANDS[harness]);
  if (!program) {
    queueMicrotask(() => finish({ ok: false, text: '', errors: [`${ACP_COMMANDS[harness]} isn't installed (not found on PATH).`] }));
    return { send: () => undefined, stop: () => undefined };
  }
  try {
    fs.mkdirSync(path.dirname(OFFICE_COMMAND), { recursive: true });
    fs.writeFileSync(OFFICE_COMMAND, OFFICE_COMMAND_SOURCE);
  } catch (err) {
    cb.log([{ kind: 'error', text: `Couldn't write the office command: ${(err as Error).message}` }]);
  }

  // Same rule as every agent: no Claude credentials or config from the office's own environment.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ANTHROPIC_|CLAUDE)/i.test(k)) env[k] = v;
  env.CUBEFARM_OFFICE_URL = `${officeAddress()}/api/office/${token}`;
  // Nano mode: the configured target + auth under the names the fetched skill reads, so it reaches the office's app.
  for (const [k, v] of Object.entries(opts.sessionEnv ?? {})) env[k] = v;

  const proc = spawn(program.file, [...program.args, ...acpArgs(opts.model)], {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32', // its own process group, so killTree takes its children too
  });
  child = proc;
  cb.log([{ kind: 'system', text: `✻ ${harness} over ACP${opts.model ? ` · ${opts.model}` : ''} · CEO` }]);

  // ---------- JSON-RPC ----------
  let seq = 0;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  const write = (m: RpcMessage) => {
    if (!proc.stdin.writable) return;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  };
  const request = <T>(method: string, params: Record<string, unknown>) =>
    new Promise<T>((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok: ok as (v: unknown) => void, fail });
      write({ id, method, params });
    });

  const titles = new Map<string, string>();
  let replaying = false; // session/load replays the old conversation: not news
  let reply = '';
  const onMessage = (m: RpcMessage) => {
    if (m.method && m.id != null) {
      // the agent asks the client something
      if (m.method === 'session/request_permission') write({ id: m.id, result: permissionOutcome(m.params) });
      else write({ id: m.id, error: { code: -32601, message: `cubefarm doesn't offer ${m.method}` } });
      return;
    }
    if (m.method === 'session/update') {
      if (replaying) return;
      const e = readUpdate(m.params?.update as Record<string, unknown> | undefined, titles);
      if (e.text) reply += e.text;
      if (e.log) cb.log(e.log);
      if (e.tool !== undefined) cb.tool(e.tool);
      return;
    }
    if (typeof m.id === 'number') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.error) p.fail(new Error(m.error.message ?? `error ${m.error.code}`));
      else p.ok(m.result);
    }
  };

  let buf = '';
  proc.stdin.on('error', () => undefined); // it exited: 'exit' reports it
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = parseRpc(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m) onMessage(m);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });
  proc.on('error', (err) => finish({ ok: false, text: '', errors: [`${harness} couldn't start: ${err.message}`] }));
  proc.on('exit', (code) => {
    for (const p of pending.values()) p.fail(new Error('exited'));
    pending.clear();
    const why = stderrTail.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
    finish({ ok: false, text: lastText, errors: [`${harness} exited (code ${code})${why ? `: ${why}` : ''}`] });
  });

  // ---------- turns ----------
  const runQueue = async () => {
    if (prompting || finished || !sessionId) return;
    const text = queue.shift();
    if (text === undefined) return finish({ ok: errors.length === 0, text: lastText, errors });
    prompting = true;
    reply = '';
    try {
      const r = await request<{ stopReason?: string }>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      turns++;
      lastText = reply.trim();
      if (lastText) {
        cb.log([{ kind: 'text', text: lastText }]);
        cb.turn?.(lastText);
      }
      if (r?.stopReason === 'cancelled') return finish({ ok: false, text: lastText, errors: ['Interrupted'], interrupted: true });
      if (r?.stopReason && r.stopReason !== 'end_turn') errors.push(`The turn ended: ${r.stopReason}`);
    } catch (err) {
      if (!finished) errors.push((err as Error).message);
    }
    prompting = false;
    void runQueue();
  };

  void (async () => {
    // Startup is bounded (unlike session/prompt turns): an agent that stays alive without answering would otherwise
    // hold a CEO session slot forever, with no terminal to recover it. The catch kills the child and reports stderr.
    const startup = <T>(p: Promise<T>) => withTimeout(p, ACP_STARTUP_TIMEOUT_MS, `${harness} did not answer during startup (waited ${ACP_STARTUP_TIMEOUT_MS / 1000}s)`);
    try {
      const init = await startup(
        request<{ agentCapabilities?: AcpCapabilities }>('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }),
      );
      // The reference clones the CEO is told to inspect: an ACP agent may treat its roots as a filesystem boundary,
      // so a session rooted at the CEO's dir can't read them unless they go with session/new and session/load.
      const dirs = additionalDirectories(init?.agentCapabilities, opts.additionalDirectories);
      const addDirs = dirs.length ? { additionalDirectories: dirs } : {};
      if (opts.resumeSessionId && init?.agentCapabilities?.loadSession) {
        replaying = true;
        try {
          await startup(request('session/load', { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [], ...addDirs }));
          sessionId = opts.resumeSessionId;
        } catch {
          cb.log([{ kind: 'system', text: '↺ The last session could not be resumed; starting a new one.' }]);
        }
        replaying = false;
      }
      // Resumed turns still prepend systemAppend so the refreshed skill/instructions reach a loaded session.
      queue.unshift(firstPrompt(opts));
      if (!sessionId) sessionId = (await startup(request<{ sessionId: string }>('session/new', { cwd: opts.cwd, mcpServers: [], ...addDirs }))).sessionId;
      cb.sessionId(sessionId);
      void runQueue();
    } catch (err) {
      finish({ ok: false, text: '', errors: [`${harness} over ACP: ${(err as Error).message}`] });
    }
  })();

  return {
    send(text) {
      if (finished) return;
      queue.push(text);
      void runQueue();
    },
    stop() {
      if (sessionId) write({ method: 'session/cancel', params: { sessionId } });
      finish({ ok: false, text: lastText, errors: ['Stopped by manager'] });
    },
  };
}
