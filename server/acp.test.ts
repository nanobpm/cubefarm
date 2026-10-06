import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { acpArgs, additionalDirectories, OFFICE_COMMAND_SOURCE, parseRpc, permissionOutcome, readUpdate, withTimeout } from './acp.ts';
import { firstPrompt, handleOfficeCall, startAcpSession } from './acpRunner.ts';
import type { SessionCallbacks, SessionResult } from './agentRunner.ts';
import { HOME_DIR } from './config.ts';

const execFileP = promisify(execFile);

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
      fs.rmSync(blocker, { force: true, maxRetries: 3 });
    }
  });
});
