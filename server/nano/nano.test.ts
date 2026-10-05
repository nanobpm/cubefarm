import { describe, expect, it, vi } from 'vitest';
import { NanoBridge, type NanoHost } from './bridge.ts';
import type { NanoApi, NanoEscalation, NanoPr, NanoSupply } from './client.ts';
import { nanoClient } from './client.ts';
import { chunkLines, escalationMessage, escalationRef, parseAnswer, parseRef, seatsFor, TranscriptReader, workerName } from './mirror.ts';

const pr = (over: Partial<NanoPr> = {}): NanoPr => ({
  prKey: 'k',
  repo: 'acme/app',
  number: 45,
  url: 'https://github.com/acme/app/pull/45',
  title: 'Add login',
  status: 'reviewing',
  round: 2,
  activeWorker: null,
  openEscalation: null,
  updatedAt: '',
  ...over,
});

const esc = (over: Partial<NanoEscalation> = {}): NanoEscalation => ({
  userTaskKey: '2251799813690001',
  kind: 'plan-review',
  kindLabel: 'Plan review',
  prKey: null,
  subjectType: 'plan',
  subjectKey: 'acme/app#12',
  subjectTitle: 'Login page',
  subjectUrl: 'https://github.com/acme/app/issues/12',
  question: 'Approve the plan?',
  formKey: 'plan-review-decision',
  processKey: null,
  formVariables: {},
  ...over,
});

const supply: NanoSupply = {
  workers: [
    { instance: 'w1', identity: 'fleet/copilot-1', stream: 's1', jobKeys: ['j1'], live: true, staleMs: 0 },
    { instance: 'w2', identity: 'fleet/claude-1', stream: 's2', jobKeys: [], live: true, staleMs: 0 },
    { instance: 'w3', identity: 'fleet/kimi', stream: 's3', jobKeys: ['j3'], live: true, staleMs: 0 },
    { instance: 'w4', identity: 'fleet/qwen', stream: 's4', jobKeys: [], live: false, staleMs: 99 },
  ],
  correlations: [
    { jobKey: 'j1', stream: 'job:j1', bpmnProcessId: 'plan-fanout', elementId: 'implement-task', planKey: 'acme/app#12' },
    { jobKey: 'j3', stream: 'job:j3', bpmnProcessId: 'convergence-loop', elementId: 'review-round', planKey: 'Acme/App#45' },
  ],
};

describe('mirror', () => {
  it('parses refs and URLs', () => {
    expect(parseRef('acme/app#12')).toEqual({ repo: 'acme/app', number: 12 });
    expect(parseRef('https://github.com/acme/app/pull/7')).toEqual({ repo: 'acme/app', number: 7 });
    expect(parseRef('nope')).toBeNull();
  });

  it('seats workers on the floor of their work', () => {
    const seats = seatsFor(supply, [pr()], ['acme/app']);
    expect(seats[0]).toMatchObject({ name: 'copilot-1', repoId: 'acme/app', status: 'working', task: 'issue', issueNumber: 12, stream: 'job:j1' });
    expect(seats[1]).toMatchObject({ status: 'idle', repoId: null, stream: null });
    expect(seats[2]).toMatchObject({ repoId: 'acme/app', task: 'fix', prNumber: 45, issueTitle: 'Add login' });
    expect(seats[3]).toMatchObject({ status: 'stopped', live: false });
  });

  it('prefers the PR a worker holds the lease on', () => {
    const seats = seatsFor(supply, [pr({ activeWorker: 'w2', number: 9 })], ['acme/app']);
    expect(seats[1]).toMatchObject({ prNumber: null }); // idle: no job, lease alone doesn't seat it
    expect(seatsFor({ workers: [{ ...supply.workers[1], jobKeys: ['x'] }] }, [pr({ activeWorker: 'w2', number: 9 })], ['acme/app'])[0]).toMatchObject({ prNumber: 9, repoId: 'acme/app' });
  });

  it('answers escalations with a choice and a note', () => {
    const e = esc();
    expect(escalationMessage(e)).toContain(`answer ${escalationRef(e)} <proceed|revise>`);
    expect(parseAnswer('hello', [e])).toBeNull();
    expect(parseAnswer('answer zzz ok', [e])).toMatch(/No open escalation/);
    expect(parseAnswer(`answer ${escalationRef(e)} maybe`, [e])).toMatch(/proceed, revise/);
    expect(parseAnswer(`answer ${escalationRef(e)} revise split it in two`, [e])).toEqual({ escalation: e, variables: { directive: 'revise', notes: 'split it in two' } });
    const p = esc({ kind: 'pr', formKey: 'pr-escalation' });
    expect(parseAnswer(`answer ${escalationRef(p)} rebase on main`, [p])).toMatchObject({ variables: { answer: 'rebase on main' } });
  });

  it('names workers from their instance when the identity is an address', () => {
    const w = { instance: 'joshs-macbook-pro-copilot-31c33e5f', identity: '127.0.0.1', stream: '', jobKeys: [], live: true, staleMs: 0 };
    expect(workerName(w)).toBe('copilot 31c3');
    expect(workerName({ ...w, identity: 'fleet/claude-1' })).toBe('claude-1');
    expect(workerName({ ...w, instance: 'omarchy-nano-coder-8f20a93d' })).toBe('coder 8f20');
  });

  it('seats a worker on the PR it holds when the job has no context (live servers)', () => {
    const s = seatsFor(
      { workers: [{ instance: 'h-copilot-ab12cd34', identity: '127.0.0.1', stream: '', family: 'Opus 4.8', jobKeys: ['9'], live: true, staleMs: 0 }], correlations: [{ jobKey: '9', stream: '34:h-copilot-ab12cd34/9' }] },
      [pr({ activeWorker: 'h-copilot-ab12cd34', status: 'converging', round: 13 })],
      ['acme/app'],
    )[0];
    expect(s).toMatchObject({ repoId: 'acme/app', task: 'fix', prNumber: 45, stream: '34:h-copilot-ab12cd34/9', doing: 'converging · round 13', family: 'Opus 4.8' });
  });

  it('reads nwf transcript events', () => {
    const r = new TranscriptReader();
    const ev = (o: object) => `${JSON.stringify({ nwfTranscriptEvent: 1, ...o })}\n`;
    const lines = r.read([
      ev({ kind: 'message', role: 'assistant', text: 'Looking at ' }),
      ev({ kind: 'message', role: 'assistant', text: 'the code.\nNow' }),
      '[usage_update]\n',
      '⚙ [tool: toolu_01ABC]\n',
      ev({ kind: 'tool-call', name: 'Viewing src/a.rs', callId: 'x', args: {} }),
      ev({ kind: 'tool-result', callId: 'x', ok: true, content: 'lots' }),
      ev({ kind: 'tool-call', name: 'bash', callId: 'z', args: { command: 'gh pr view 38\n--json x' } }),
      ev({ kind: 'tool-result', callId: 'y', ok: false, content: 'denied' }),
      ev({ kind: 'message', role: 'assistant', text: ' fixing it' }),
    ]);
    expect(lines).toEqual([
      { kind: 'text', text: 'Looking at the code.' },
      { kind: 'text', text: 'Now' },
      { kind: 'tool', text: 'Viewing src/a.rs', tool: 'Viewing' },
      { kind: 'tool', text: 'bash: gh pr view 38', tool: 'bash' },
      { kind: 'error', text: '✗ denied' },
    ]);
    expect(r.end()).toEqual([{ kind: 'text', text: 'fixing it' }]);
  });

  it('uses short user-task keys whole', () => {
    expect(escalationRef({ userTaskKey: '233492' })).toBe('233492');
    expect(escalationRef({ userTaskKey: '2251799813690001' })).toBe('690001');
  });

  it('cleans terminal bytes', () => {
    expect(chunkLines('\u001b[32mok\u001b[0m\r\nspin 1\rspin 2\n\n')).toEqual(['ok', 'spin 2']);
  });
});

describe('client', () => {
  it('calls /app/api with the secret', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ prs: [pr()] }), { status: 200 }));
    const c = nanoClient('http://h:3000/', { secret: 's', fetch: f as unknown as typeof fetch });
    expect(await c.activePrs()).toHaveLength(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h:3000/app/api/status');
    expect((init.headers as Record<string, string>)['x-hook-secret']).toBe('s');
  });

  it('reports errors', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'bad base' }), { status: 400 }));
    const c = nanoClient('http://h', { fetch: f as unknown as typeof fetch });
    await expect(c.startPlanFanout({ issue: 'a/b#1', baseBranch: 'main' })).rejects.toThrow(/400 bad base/);
  });
});

describe('bridge', () => {
  const setup = (over: Partial<NanoApi> = {}) => {
    const api: NanoApi = {
      supply: async () => supply,
      activePrs: async () => [pr()],
      escalations: async () => [esc()],
      transcript: async (stream, from) => (stream === 'job:j1' && from === 0 ? { status: 'open', nextOffset: 3, entries: [{ offset: 0, chunk: 'hello\nworld\n' }] } : null),
      startPlanFanout: vi.fn(async () => ({})),
      completeUserTask: vi.fn(async () => ({})),
      ...over,
    };
    const host = { repoIds: () => ['acme/app'], seat: vi.fn(), unseat: vi.fn(), log: vi.fn(), phone: vi.fn(), needsHuman: vi.fn() } satisfies NanoHost;
    const bridge = new NanoBridge(api, host, { url: 'http://nwf', pollMs: 1000, baseBranch: '' });
    return { api, host, bridge };
  };

  it('seats, logs and phones once per escalation', async () => {
    const { host, bridge } = setup();
    await bridge.tick();
    await bridge.tick();
    expect(host.seat).toHaveBeenCalledTimes(8);
    expect(host.log).toHaveBeenCalledTimes(1);
    expect(host.log).toHaveBeenCalledWith('w1', [{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'world' }]);
    expect(host.phone).toHaveBeenCalledTimes(1);
    expect(host.needsHuman).toHaveBeenCalledTimes(1);
  });

  it('unseats workers that leave', async () => {
    let s = supply;
    const { host, bridge } = setup({ supply: async () => s });
    await bridge.tick();
    s = { workers: supply.workers.slice(1) };
    await bridge.tick();
    expect(host.unseat).toHaveBeenCalledWith('w1');
  });

  it('hands off on the default branch with confirmation, or a templated base', async () => {
    const { api, bridge } = setup();
    expect(await bridge.handOff({ fullName: 'acme/app', defaultBranch: 'main' }, 12)).toBe('main');
    expect(api.startPlanFanout).toHaveBeenCalledWith({ issue: 'acme/app#12', baseBranch: 'main', confirmDefaultBase: true });
    const b2 = new NanoBridge(api, setup().host, { url: '', pollMs: 1000, baseBranch: 'epic/issue-{n}' });
    expect(await b2.handOff({ fullName: 'acme/app', defaultBranch: 'main' }, 7)).toBe('epic/issue-7');
    expect(api.startPlanFanout).toHaveBeenLastCalledWith({ issue: 'acme/app#7', baseBranch: 'epic/issue-7' });
  });

  it('completes the user task from a phone answer', async () => {
    const { api, bridge } = setup();
    const reply = await bridge.answer(`answer ${escalationRef(esc())} proceed looks good`);
    expect(api.completeUserTask).toHaveBeenCalledWith(esc().userTaskKey, { directive: 'proceed', notes: 'looks good' });
    expect(reply).toMatch(/Sent to nano-workforce/);
    expect(await bridge.answer('hi')).toBeNull();
  });

  it('says once when the app is down and when it is back', async () => {
    let up = false;
    const { host, bridge } = setup({
      supply: async () => {
        if (!up) throw new Error('ECONNREFUSED');
        return supply;
      },
    });
    await bridge.tick();
    await bridge.tick();
    up = true;
    await bridge.tick();
    const texts = host.phone.mock.calls.map((c) => c[0] as string);
    expect(texts.filter((t) => t.includes("Can't reach"))).toHaveLength(1);
    expect(texts.some((t) => t.includes('reachable again'))).toBe(true);
  });
});
