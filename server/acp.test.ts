import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { acpArgs, additionalDirectories, OFFICE_COMMAND_SOURCE, parseRpc, permissionOutcome, readUpdate, TimeoutError, withTimeout } from './acp.ts';
import { ACP_STARTUP_TIMEOUT_MS, firstPrompt, handleOfficeCall, startAcpSession } from './acpRunner.ts';
import type { LogEntry, SessionCallbacks, SessionResult } from './agentRunner.ts';
import { HOME_DIR } from './config.ts';

const execFileP = promisify(execFile);

/** SessionCallbacks that record everything, with `finished` resolving `result`. */
function recordSession() {
  const logs: LogEntry[] = [];
  const tools: (string | null)[] = [];
  const turns: string[] = [];
  let sessionId: string | null = null;
  let cb!: SessionCallbacks;
  const result = new Promise<SessionResult>((done) => {
    cb = {
      log: (entries) => logs.push(...entries),
      tool: (name) => {
        tools.push(name);
        // A message to send the moment this tool starts (set by the test): runs synchronously mid-turn, so the send
        // lands while a prompt is in flight — polling from the test body would always lose to the queue drain.
        record.sendWhenTool?.(name);
      },
      sessionId: (id) => {
        sessionId = id;
      },
      browserUrl: () => undefined,
      screenshot: () => undefined,
      turn: (text) => turns.push(text),
      finished: done,
    };
  });
  const record = { logs, tools, turns, result, cb, sendWhenTool: undefined as undefined | ((tool: string | null) => void), get sessionId() { return sessionId; } };
  return record;
}

const OPTS = { cwd: os.tmpdir(), prompt: 'Review the queue.', systemAppend: 'You are the CEO.', model: '', effort: 'high' as const, browserTesting: false, additionalDirectories: [], role: 'ceo' as const };

/**
 * A `nano-coder` stub on PATH (a dir holding only it), restoring PATH on `close()`. The fake's behaviour is a plain
 * JavaScript file the shim runs with node — identical on every platform, with none of the quoting a `node -e` one-liner
 * would need through a shell. `close()` (not `using`) because the child may outlive the test body by a moment.
 */
function stubHarness(script: string): { dir: string; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-acp-stub-'));
  const fake = path.join(dir, 'fake-acp.cjs');
  fs.writeFileSync(fake, script);
  const file = path.join(dir, process.platform === 'win32' ? 'nano-coder.cmd' : 'nano-coder');
  const run = `${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`;
  fs.writeFileSync(file, process.platform === 'win32' ? `@echo off\r\n${run} %*\r\n` : `#!/bin/sh\nexec ${run} "$@"\n`, { mode: 0o755 });
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const saved = process.env[key];
  process.env[key] = dir + path.delimiter + (saved ?? '');
  return {
    dir,
    close() {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

describe('acp', () => {
  it('starts the harness in ACP mode, with a model only when one is set', () => {
    expect(acpArgs('')).toEqual(['--acp']);
    expect(acpArgs('github-copilot/kimi-k3')).toEqual(['--acp', '--model', 'github-copilot/kimi-k3']);
  });

  it('reads JSON-RPC lines and skips anything else', () => {
    expect(parseRpc('{"id":1,"jsonrpc":"2.0","result":{}}')).toEqual({ id: 1, jsonrpc: '2.0', result: {} });
    expect(parseRpc('ACP harness ready')).toBeNull();
    expect(parseRpc('[1]')).toBeNull();
  });

  it('allows tool calls, preferring "always"', () => {
    const options = [
      { optionId: 'no', kind: 'reject_once' },
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
    ];
    expect(permissionOutcome({ options })).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    expect(permissionOutcome({})).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it("turns nano-coder's updates into the reply, steps and the current tool", () => {
    const titles = new Map<string, string>();
    expect(readUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'do' } }, titles)).toEqual({ text: 'do' });
    const call = readUpdate({ sessionUpdate: 'tool_call', kind: 'execute', title: 'bash', rawInput: { command: 'echo hi' }, toolCallId: 'c1', status: 'in_progress' }, titles);
    expect(call).toEqual({ tool: 'bash', log: [{ kind: 'tool', tool: 'bash', text: 'bash echo hi' }] });
    const done = readUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'hi\nthere\n' }, titles);
    expect(done).toEqual({ tool: null, log: [{ kind: 'result', tool: 'bash', text: '  ⎿ hi (+1 lines)' }] });
    expect(readUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' }, titles)).toEqual({});
  });

  it('gives the instructions with the first prompt, as ACP has no system prompt', () => {
    expect(firstPrompt({ systemAppend: 'You are the CEO.', prompt: 'Review.' })).toBe('You are the CEO.\n\n---\n\nReview.');
  });

  it('passes the reference clones to a session only when the agent takes additional directories', () => {
    // An ACP agent may treat its roots as a filesystem boundary: without additionalDirectories on session/new and
    // session/load, a CEO rooted at its own dir can't read the clones its instructions tell it to inspect.
    const dirs = ['/clones/app', '/clones/site'];
    expect(additionalDirectories({ sessionCapabilities: { additionalDirectories: true } }, dirs)).toEqual(dirs);
    expect(additionalDirectories({ sessionCapabilities: { additionalDirectories: false } }, dirs)).toEqual([]);
    expect(additionalDirectories({}, dirs)).toEqual([]);
    expect(additionalDirectories(undefined, dirs)).toEqual([]);
    expect(additionalDirectories({ sessionCapabilities: { additionalDirectories: true } }, [])).toEqual([]);
  });

  it('refuses tool calls for a session that has ended', async () => {
    expect(await handleOfficeCall('nope', 'company_status', {})).toEqual({ error: 'This CEO session has ended.' });
  });

  it('bounds a request only when a timeout is given', async () => {
    // The startup timeout (acpRunner) relies on this: a bounded request fails after ms; an unbounded one (a
    // session/prompt turn) is returned untouched so a long turn is never cut off.
    await expect(withTimeout(new Promise(() => undefined), 20, 'too slow')).rejects.toThrow('too slow');
    const slow = new Promise<string>((ok) => setTimeout(() => ok('done'), 30));
    await expect(withTimeout(slow, 1000, 'too slow')).resolves.toBe('done');
    const passthrough = Promise.resolve('x');
    expect(withTimeout(passthrough, undefined, 'unused')).toBe(passthrough);
  });

  it('fails a timeout with a TimeoutError, but passes a real rejection through unchanged', async () => {
    // acpRunner's session/load catch tells these apart: a genuine "no such session" reply is recoverable (fall through
    // to session/new on the same process), but a TimeoutError must be rethrown to kill the hung child. If withTimeout
    // used a plain Error for both, a load timeout would be swallowed as if the session were merely missing.
    await expect(withTimeout(new Promise(() => undefined), 10, 'too slow')).rejects.toBeInstanceOf(TimeoutError);
    const loadError = Promise.reject(new Error('session not found'));
    await expect(withTimeout(loadError, 1000, 'too slow')).rejects.not.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.reject(new Error('session not found')), 1000, 'too slow')).rejects.toThrow('session not found');
  });

  it('decodes base64url tool arguments, so no shell quoting is needed', async () => {
    // cmd.exe/PowerShell pass single quotes literally, so quoted JSON never reaches the helper; base64url
    // (letters/digits/-/_ only) survives every shell. The office command must decode it back to the exact JSON.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-office-')), 'office.cjs');
    fs.writeFileSync(file, OFFICE_COMMAND_SOURCE);
    try {
      const b64 = Buffer.from('{"a":"b c","q":"\\"x\\" + / ="}', 'utf8').toString('base64url');
      // CUBEFARM_OFFICE_URL points at a closed port: the command decodes the body, then fails to connect — proving
      // the argument parsed as a flag + value, not as literal quoted JSON (which would exit 2 on usage).
      await expect(execFileP(process.execPath, [file, 'company_status', '-b', b64], { env: { ...process.env, CUBEFARM_OFFICE_URL: 'http://127.0.0.1:1' } })).rejects.toThrow(/could not be reached/);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('ends the session without spawning the harness when the office command cannot be written', async () => {
    // Regression (Copilot review): a failed helper write used to only log, then spawn a CEO whose mandatory first
    // company_status call was guaranteed to fail (or hit a stale helper). A file where bin/ belongs makes mkdir fail.
    // startAcpSession checks for the CLI before writing the helper, so stub the harness on PATH: the test must reach
    // the write failure whether or not the host really has nano-coder installed.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-nano-stub-'));
    const stub = path.join(stubDir, process.platform === 'win32' ? 'nano-coder.cmd' : 'nano-coder');
    fs.writeFileSync(stub, process.platform === 'win32' ? '@echo off\r\nexit 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const savedPath = process.env[pathKey];
    process.env[pathKey] = stubDir + path.delimiter + (savedPath ?? '');
    const blocker = path.join(HOME_DIR, 'bin');
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(blocker, 'x');
    const result = new Promise<SessionResult>((done) => {
      const cb: SessionCallbacks = {
        log: () => undefined,
        tool: () => undefined,
        sessionId: () => undefined,
        browserUrl: () => undefined,
        screenshot: () => undefined,
        finished: done,
      };
      const handle = startAcpSession('nano-coder', { cwd: os.tmpdir(), prompt: 'p', systemAppend: 's', model: '', effort: 'high', browserTesting: false, additionalDirectories: [], role: 'ceo' }, cb);
      // The finish is deferred so the caller can install this handle first; it must be a safe no-op, not a crash.
      handle.stop();
    });
    try {
      const r = await result;
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toContain("Couldn't write the office command");
    } finally {
      if (savedPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = savedPath;
      fs.rmSync(blocker, { force: true, maxRetries: 3 });
      fs.rmSync(stubDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  // A deterministic fake ACP harness (fed to node by stubHarness): answers initialize/session/new, then plays one
  // turn per session/prompt — a thought, a tool call that asks permission, its result, a reply chunk — and remembers
  // the prompts it saw so the test can check what the office sent. The turn ends only after the office's permission
  // reply arrives, so the test can queue a follow-up mid-turn with no race.
  const FAKE_ACP = `
const fs = require('node:fs');
const log = process.env.FAKE_ACP_LOG;
const seen = [];
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'fake-session' } });
    else if (m.method === 'session/prompt') {
      const text = m.params.prompt.map((p) => p.text).join('\\n');
      seen.push({ id: m.id, sessionId: m.params.sessionId, text });
      if (log) fs.writeFileSync(log, JSON.stringify(seen.map((s) => s.text)));
      const update = (u) => send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: u } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about ' + text.slice(0, 20) } });
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', rawInput: { command: 'company_status' }, status: 'in_progress' });
      send({ id: 900 + seen.length, method: 'session/request_permission', params: { sessionId: m.params.sessionId, options: [{ optionId: 'no', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }] } });
    } else if (m.id >= 900 && m.result) {
      // The office's permission reply: now finish the turn it belongs to.
      const p = seen.find((s) => 900 + seen.indexOf(s) === m.id) ?? seen[seen.length - 1];
      const update = (u) => send({ method: 'session/update', params: { sessionId: p.sessionId, update: u } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'all quiet' });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer to: ' + p.text.slice(0, 60) } });
      send({ id: p.id, result: { stopReason: 'end_turn' } });
    } else if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'unknown method ' + m.method } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

  it('runs the full ACP wire lifecycle against a deterministic fake harness', async () => {
    // Regression (Copilot review): only the pure helpers and a pre-spawn failure were tested, so a runner that could
    // no longer speak ACP at all would still pass CI. The fake answers every request in turn, so the whole lifecycle
    // — initialize, session/new, streamed updates, a permission reply, a queued manager message, completion — runs
    // with no timers and no real CLI.
    const promptLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cubefarm-acp-log-')), 'prompts.json');
    const stub = stubHarness(FAKE_ACP);
    const s = recordSession();
    const handle = startAcpSession('nano-coder', { ...OPTS, sessionEnv: { FAKE_ACP_LOG: promptLog } }, s.cb);
    try {
      // The first prompt must carry the instructions (ACP has no system prompt) and the queued message must wait for
      // the turn to end, then run as its own turn. The send goes out from inside the tool callback — synchronously
      // mid-turn, while the fake holds the turn open for its permission reply — so it queues with no race.
      s.sendWhenTool = (tool) => {
        if (tool === 'bash') {
          s.sendWhenTool = undefined;
          handle.send('What is next?');
        }
      };
      const r = await s.result;
      expect(r.ok).toBe(true);
      expect(r.turns).toBe(2);
      expect(r.errors).toEqual([]);
      expect(s.sessionId).toBe('fake-session');
      expect(s.turns).toEqual(['Answer to: You are the CEO.\n\n---\n\nReview the queue.', 'Answer to: What is next?']);
      expect(s.tools).toEqual(['bash', null, 'bash', null, null]); // per turn: the tool starts, finishes; finish clears it
      expect(s.logs.some((e) => e.kind === 'thinking' && e.text.includes('thinking about'))).toBe(true);
      expect(s.logs.some((e) => e.kind === 'tool' && e.text === 'bash company_status')).toBe(true);
      expect(s.logs.some((e) => e.kind === 'result' && e.text.includes('all quiet'))).toBe(true);
      const prompts = JSON.parse(fs.readFileSync(promptLog, 'utf8')) as string[];
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toBe('You are the CEO.\n\n---\n\nReview the queue.');
      expect(prompts[1]).toBe('What is next?');
    } finally {
      handle.stop();
      stub.close();
      fs.rmSync(path.dirname(promptLog), { recursive: true, force: true, maxRetries: 3 });
    }
  }, 30_000);

  it('fails the session at once when the harness stops accepting input, instead of hanging on the prompt', async () => {
    // Regression (Copilot review): session/prompt has no timeout by design, so a harness that closed its input pipe
    // left the request pending until the 60s startup timeout — or, mid-turn, forever, with the CEO stuck "working".
    // The write must report the dead pipe and fail the request immediately. This fake exits the moment it starts;
    // the session must end in well under the startup timeout (it would pass trivially, just slowly, without the fix).
    const stub = stubHarness('process.exit(0);\n');
    const s = recordSession();
    const t0 = Date.now();
    const handle = startAcpSession('nano-coder', OPTS, s.cb);
    try {
      const r = await s.result;
      expect(r.ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(ACP_STARTUP_TIMEOUT_MS);
      expect(r.errors.join(' ')).toMatch(/not accepting input|exited/);
    } finally {
      handle.stop();
      stub.close();
    }
  }, 30_000);
});
