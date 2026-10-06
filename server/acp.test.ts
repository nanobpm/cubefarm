import { describe, expect, it } from 'vitest';
import { acpArgs, parseRpc, permissionOutcome, readUpdate } from './acp.ts';
import { firstPrompt, handleOfficeCall } from './acpRunner.ts';

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

  it('refuses tool calls for a session that has ended', async () => {
    expect(await handleOfficeCall('nope', 'company_status', {})).toEqual({ error: 'This CEO session has ended.' });
  });
});
