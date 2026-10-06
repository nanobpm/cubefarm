import { describe, expect, it, vi } from 'vitest';
import { NanoBridge, nanoAgentEnv, type NanoHost } from './bridge.ts';
import type { EngineApi, EngineInstance, EngineJob, NanoApi, NanoEscalation, NanoPr, NanoSupply } from './client.ts';
import { engineClient, nanoClient } from './client.ts';
import { BENCH, buildWorld, parseProcess, type ProcessModel } from './floors.ts';
import { chunkLines, escalationMessage, escalationRef, parseAnswer, parseRef, TranscriptReader, workerName } from './mirror.ts';

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
    { jobKey: 'j1', stream: 'job:j1' },
    { jobKey: 'j3', stream: 'job:j3' },
  ],
};

const XML = `<?xml version="1.0"?><bpmn:definitions><bpmn:process id="convergence-loop">
  <bpmn:serviceTask id="review-round" name="Review round (agent)"><bpmn:extensionElements><zeebe:taskDefinition type="senior:pr-review" /></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:serviceTask id="persist-round" name="Record round"><bpmn:extensionElements><zeebe:taskDefinition type="pr.persist-round" /></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:serviceTask id="adversarial-review" name="Adversarial review (agent)"><bpmn:extensionElements><zeebe:taskDefinition type="senior:adversarial-review" /></bpmn:extensionElements></bpmn:serviceTask>
  <bpmn:userTask id="merge-approval" name="Approve merge (human)" />
  <bpmn:intermediateCatchEvent id="wait-review" name="Wait: review ready" />
  <bpmn:sequenceFlow id="f1" sourceRef="review-round" targetRef="persist-round" />
  <bpmn:sequenceFlow id="f2" sourceRef="persist-round" targetRef="adversarial-review" />
</bpmn:process>
<bpmndi:BPMNDiagram><bpmndi:BPMNPlane>
  <bpmndi:BPMNShape id="s1" bpmnElement="review-round"><dc:Bounds x="100" y="80" width="100" height="80" /></bpmndi:BPMNShape>
  <bpmndi:BPMNShape id="s2" bpmnElement="persist-round"><dc:Bounds x="250" y="80" width="100" height="80" /></bpmndi:BPMNShape>
  <bpmndi:BPMNShape id="s3" bpmnElement="adversarial-review"><dc:Bounds x="400" y="80" width="100" height="80" /></bpmndi:BPMNShape>
  <bpmndi:BPMNShape id="s4" bpmnElement="wait-review"><dc:Bounds x="550" y="102" width="36" height="36" /></bpmndi:BPMNShape>
  <bpmndi:BPMNEdge id="e1" bpmnElement="f1"><di:waypoint x="200" y="120" /><di:waypoint x="250" y="120" /></bpmndi:BPMNEdge>
  <bpmndi:BPMNEdge id="e2" bpmnElement="f2"><di:waypoint x="350" y="120" /><di:waypoint x="400" y="120" /></bpmndi:BPMNEdge>
</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>`;

const inst = (key: string, over: Partial<EngineInstance> = {}): EngineInstance => ({
  processInstanceKey: key,
  processDefinitionKey: 'd1',
  processDefinitionId: 'convergence-loop',
  parentProcessInstanceKey: null,
  startDate: `2026-10-0${key.length}T00:00:00Z`,
  ...over,
});
const job = (jobKey: string, worker: string, processInstanceKey: string, elementId = 'review-round'): EngineJob => ({
  jobKey,
  worker,
  processInstanceKey,
  elementId,
  type: 'senior:pr-review',
  state: 'CREATED',
  processDefinitionId: 'convergence-loop',
  processDefinitionKey: 'd1',
});
const instances = [inst('100'), inst('200', { processDefinitionId: 'delivery-graph-54bde3dae2fa', processDefinitionKey: 'd2' }), inst('300', { parentProcessInstanceKey: '200' })];
const jobs = [job('j1', 'w1', '100'), job('j3', 'w3', '300', 'adversarial-review')];
const world = (over: Partial<Parameters<typeof buildWorld>[0]> = {}) =>
  buildWorld({
    supply,
    prs: [pr({ processKey: '100' })],
    escalations: [esc({ processKey: '200', subjectTitle: 'Ship the graph' })],
    instances,
    jobs,
    elements: new Map([
      [
        '100',
        [
          { elementInstanceKey: '101', processInstanceKey: '100', elementId: 'adversarial-review', type: 'SERVICE_TASK', state: 'ACTIVE', startDate: '2026-10-06T00:00:00Z' },
          { elementInstanceKey: '102', processInstanceKey: '100', elementId: 'wait-review', type: 'INTERMEDIATE_CATCH_EVENT', state: 'ACTIVE' },
          { elementInstanceKey: '103', processInstanceKey: '100', elementId: 'review-round', type: 'SERVICE_TASK', state: 'COMPLETED' },
          { elementInstanceKey: '104', processInstanceKey: '100', elementId: 'review-round', type: 'SERVICE_TASK', state: 'COMPLETED' },
          { elementInstanceKey: '105', processInstanceKey: '100', elementId: 'review-round', type: 'SERVICE_TASK', state: 'ACTIVE' },
          { elementInstanceKey: '106', processInstanceKey: '100', elementId: 'persist-round', type: 'SERVICE_TASK', state: 'COMPLETED', hasIncident: true },
        ],
      ],
    ]),
    models: new Map<string, ProcessModel>([['d1', parseProcess(XML)], ['d2', parseProcess(XML)]]),
    names: new Map(),
    ...over,
  });

describe('mirror', () => {
  it('parses refs and URLs', () => {
    expect(parseRef('acme/app#12')).toEqual({ repo: 'acme/app', number: 12 });
    expect(parseRef('https://github.com/acme/app/pull/7')).toEqual({ repo: 'acme/app', number: 7 });
    expect(parseRef('nope')).toBeNull();
  });

  it('reads agent steps (stations) and named elements from BPMN', () => {
    const m = parseProcess(XML);
    expect(m.stations).toEqual([
      { elementId: 'review-round', name: 'Review round', jobType: 'senior:pr-review' },
      { elementId: 'adversarial-review', name: 'Adversarial review', jobType: 'senior:adversarial-review' },
    ]);
    expect(m.elements.get('merge-approval')).toMatchObject({ name: 'Approve merge (human)', kind: 'userTask' });
  });

  it('makes a floor per root process, named after its PR or its definition', () => {
    const w = world();
    expect(w.floors.map((f) => f.id)).toEqual(['convergence-loop/app-pr45', 'delivery-graph/54bde3dae2fa']);
    expect(w.floors[0].pulls[0]).toMatchObject({ number: 45, state: 'OPEN' });
    expect(w.floors[0].description).toMatch(/reviewing · round 2/);
    expect(w.floors[1].description).toBe('Ship the graph');
  });

  it('puts what waits on the whiteboard: escalations, events, agent steps with no worker', () => {
    const w = world();
    expect(w.floors[0].issues.map((i) => i.title)).toEqual(['🕒 Adversarial review (agent): no worker yet (senior:adversarial-review)', '⏳ Wait: review ready']);
    expect(w.floors[1].issues[0]).toMatchObject({ number: 2251799813690001, labels: ['needs-human', 'plan-review'] });
  });

  it('suppresses only the user task that has an escalation, not every human step', () => {
    const w = world({
      prs: [],
      instances: [inst('500')],
      jobs: [],
      escalations: [esc({ processKey: '500', userTaskKey: '501', subjectTitle: 'Approve A' })],
      elements: new Map([
        [
          '500',
          [
            { elementInstanceKey: '501', processInstanceKey: '500', elementId: 'merge-approval', type: 'USER_TASK', state: 'ACTIVE', startDate: '2026-10-06T00:00:00Z' },
            { elementInstanceKey: '502', processInstanceKey: '500', elementId: 'merge-approval', type: 'USER_TASK', state: 'ACTIVE', startDate: '2026-10-06T00:00:00Z' },
          ],
        ],
      ]),
    });
    const titles = w.floors[0].issues.map((i) => i.title);
    expect(titles.filter((t) => t.startsWith('🙋')).length).toBe(1); // ut 502 only; ut 501's escalation sticky replaces its 🙋
    expect(titles.some((t) => t.startsWith('🚨'))).toBe(true);
  });

  it('marks a user-task shape as an escalation only when the escalation is its own', () => {
    const XML2 = `<?xml version="1.0"?><bpmn:definitions><bpmn:process id="two-humans">
      <bpmn:userTask id="approve-a" name="Approve A" />
      <bpmn:userTask id="approve-b" name="Approve B" />
    </bpmn:process><bpmndi:BPMNDiagram><bpmndi:BPMNPlane>
      <bpmndi:BPMNShape id="sa" bpmnElement="approve-a"><dc:Bounds x="10" y="10" width="80" height="60" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="sb" bpmnElement="approve-b"><dc:Bounds x="120" y="10" width="80" height="60" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane></bpmndi:BPMNDiagram></bpmn:definitions>`;
    const w = world({
      prs: [],
      instances: [inst('600', { processDefinitionKey: 'd3', processDefinitionId: 'two-humans' })],
      jobs: [],
      escalations: [esc({ processKey: '600', userTaskKey: '601', subjectTitle: 'Approve A' })],
      elements: new Map([
        [
          '600',
          [
            { elementInstanceKey: '601', processInstanceKey: '600', elementId: 'approve-a', type: 'USER_TASK', state: 'ACTIVE', startDate: '2026-10-06T00:00:00Z' },
            { elementInstanceKey: '602', processInstanceKey: '600', elementId: 'approve-b', type: 'USER_TASK', state: 'ACTIVE', startDate: '2026-10-06T00:00:00Z' },
          ],
        ],
      ]),
      models: new Map<string, ProcessModel>([['d3', parseProcess(XML2)]]),
    });
    const b = w.floors[0].board;
    if (b.kind !== 'process') throw new Error('not a process board');
    const by = Object.fromEntries(b.shapes.map((s) => [s.id, s]));
    expect(by['approve-a']).toMatchObject({ waiting: 'escalation' });
    expect(by['approve-b']).toMatchObject({ waiting: 'human' }); // a different user task's escalation must not bleed onto it
  });

  it('seats workers at the desk of their step, on the root floor; idle ones on the bench', () => {
    const w = world();
    expect(w.seats[0]).toMatchObject({ instance: 'w1', floorId: 'convergence-loop/app-pr45', desk: 0, doing: 'Review round', task: 'fix', prNumber: 45, stream: 'job:j1' });
    expect(w.seats[1]).toMatchObject({ instance: 'w2', floorId: BENCH, desk: null, status: 'idle' });
    // a call activity's job is on its root's floor
    expect(w.seats[2]).toMatchObject({ instance: 'w3', floorId: 'delivery-graph/54bde3dae2fa', desk: 1, doing: 'Adversarial review', issueTitle: 'Ship the graph' });
  });

  it('draws the process board: tokens, loop counts, workers, what waits, flows taken', () => {
    const b = world().floors[0].board;
    if (b.kind !== 'process') throw new Error('not a process board');
    const by = Object.fromEntries(b.shapes.map((s) => [s.id, s]));
    expect(by['review-round']).toMatchObject({ active: 1, done: 2, workers: ['copilot-1'], waiting: null, agent: true, x: 100, w: 100 });
    expect(by['adversarial-review']).toMatchObject({ active: 1, waiting: 'queued', since: Date.parse('2026-10-06T00:00:00Z') });
    expect(by['persist-round']).toMatchObject({ incident: true, done: 1, agent: false });
    expect(by['wait-review']).toMatchObject({ waiting: 'event' });
    expect(b.edges.map((e) => e.taken)).toEqual([true, true]);
    expect(b.bounds).toEqual({ x: 100, y: 80, w: 486, h: 80 });
    expect(b.title).toBe('Add login');
  });

  it('draws the fleet board: held and queued per job type, the bench, escalations', () => {
    const f = world().fleet;
    if (f.kind !== 'fleet') throw new Error('not the fleet');
    expect(f.types.find((t) => t.type === 'senior:adversarial-review')).toMatchObject({ queued: [{ floor: 'convergence-loop/app-pr45', step: 'Adversarial review' }] });
    expect(f.types.find((t) => t.type === 'senior:pr-review')?.held).toEqual([
      { worker: 'copilot-1', floor: 'convergence-loop/app-pr45', since: null },
      { worker: 'kimi', floor: 'delivery-graph/54bde3dae2fa', since: null },
    ]);
    expect(f.idle).toEqual([{ name: 'claude-1', family: '' }]);
    expect(f.offline).toEqual(['qwen']);
    expect(f.escalations).toEqual([{ ref: '2251799813690001', label: 'Plan review: Ship the graph', floor: 'delivery-graph/54bde3dae2fa' }]);
    expect(f.processes.map((p) => p.floor)).toEqual(['convergence-loop/app-pr45', 'delivery-graph/54bde3dae2fa']);
  });

  it('keeps a floor its name when its PR drops out of view', () => {
    const names = new Map<string, string>();
    world({ names });
    expect(world({ names, prs: [] }).floors[0].id).toBe('convergence-loop/app-pr45');
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

  it("sends Basic Auth and reads the agent skill", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ format: 'markdown', skill: '# skill' }), { status: 200 }));
    const c = nanoClient('http://merlin.local:3000', { auth: 'Basic dTpw', fetch: f as unknown as typeof fetch });
    expect(await c.agentSkill()).toBe('# skill');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://merlin.local:3000/app/api/agent/skill');
    expect((init.headers as Record<string, string>).authorization).toBe('Basic dTpw');
  });

  it('reports errors', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'bad base' }), { status: 400 }));
    const c = nanoClient('http://h', { fetch: f as unknown as typeof fetch });
    await expect(c.startPlanFanout({ issue: 'a/b#1', baseBranch: 'main' })).rejects.toThrow(/400 bad base/);
  });
});

describe('engine client', () => {
  it('searches /v2 and pages with the cursor', async () => {
    const calls: unknown[] = [];
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      const n = body.page.after ? 1 : 500;
      return new Response(JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ jobKey: String(i), worker: i % 2 ? 'w' : '' })), page: { endCursor: 'c1' } }));
    });
    const e = engineClient('http://h:8080/', { fetch: f as unknown as typeof fetch });
    expect((await e.activeJobs()).length).toBe(250);
    expect(f.mock.calls[0][0]).toBe('http://h:8080/v2/jobs/search');
    expect(calls[1]).toMatchObject({ filter: { state: 'CREATED' }, page: { after: 'c1' } });
  });
});

describe('bridge', () => {
  const setup = (over: Partial<NanoApi> = {}, engineOver: Partial<EngineApi> = {}) => {
    const api: NanoApi = {
      supply: async () => supply,
      activePrs: async () => [pr({ processKey: '100' })],
      escalations: async () => [esc()],
      transcript: async (stream, from) => (stream === 'job:j1' && from === 0 ? { status: 'open', nextOffset: 3, entries: [{ offset: 0, chunk: 'hello\nworld\n' }] } : null),
      startPlanFanout: vi.fn(async () => ({})),
      completeUserTask: vi.fn(async () => ({})),
      agentSkill: async () => '# skill',
      ...over,
    };
    const engine: EngineApi = {
      activeInstances: async () => instances,
      activeJobs: async () => jobs,
      elements: async () => [],
      processXml: vi.fn(async () => XML),
      ...engineOver,
    };
    const host = { floors: vi.fn(async () => undefined), seat: vi.fn(), unseat: vi.fn(), log: vi.fn(), phone: vi.fn(), needsHuman: vi.fn(), workers: vi.fn((): string[] => []) } satisfies NanoHost;
    const bridge = new NanoBridge(api, engine, host, { url: 'http://nwf', pollMs: 1000, baseBranch: '' });
    return { api, engine, host, bridge };
  };

  it('opens floors, seats, logs and phones once per escalation', async () => {
    const { host, engine, bridge } = setup();
    await bridge.tick();
    await bridge.tick();
    expect(engine.processXml).toHaveBeenCalledTimes(2); // once per definition
    expect((host.floors.mock.calls[0] as unknown as [{ id: string }[]])[0].map((f) => f.id)).toEqual(['convergence-loop/app-pr45', 'delivery-graph/54bde3dae2fa']);
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

  it('flushes and forgets a departed worker\u2019s stream, not only ones still seated', async () => {
    // The leak: a worker that vanishes is unseated, but its reader/offset/following entry lived on and its last
    // buffered line was dropped (the flush only ran for workers still in `seats`). An assistant message with no
    // trailing newline stays buffered until the stream ends — on departure it must be flushed, not lost.
    let s = supply;
    const buffered = JSON.stringify({ nwfTranscriptEvent: 1, kind: 'message', role: 'assistant', text: 'tail' });
    const { host, bridge } = setup({
      supply: async () => s,
      transcript: async (stream, from) => (stream === 'job:j1' && from === 0 ? { status: 'open', nextOffset: 1, entries: [{ offset: 0, chunk: buffered }] } : null),
    });
    await bridge.tick();
    expect(host.log).not.toHaveBeenCalledWith('w1', expect.anything()); // still buffered, nothing emitted yet
    s = { workers: supply.workers.slice(1) };
    await bridge.tick();
    expect(host.unseat).toHaveBeenCalledWith('w1');
    expect(host.log).toHaveBeenCalledWith('w1', [{ kind: 'text', text: 'tail' }]);
  });

  it('unseats a persisted worker the supply never reports (ghost desk after a restart)', async () => {
    // The office kept 'wGhost' at a desk across a restart, but it is gone from nano-workforce. This bridge process
    // never saw it seated, so only reconciling against the host's persisted workers clears it.
    const { host, bridge } = setup();
    host.workers.mockReturnValue(['wGhost']);
    await bridge.tick();
    expect(host.unseat).toHaveBeenCalledWith('wGhost');
  });

  it('keys a child instance\u2019s elements under its root process (call activities on the root floor)', async () => {
    const roots = [
      inst('200', { processDefinitionId: 'delivery-graph-54bde3dae2fa', processDefinitionKey: 'd2' }),
      inst('300', { processDefinitionId: 'delivery-graph-54bde3dae2fa', processDefinitionKey: 'd2', parentProcessInstanceKey: '200' }),
    ];
    const { host, bridge } = setup(
      { supply: async () => ({ workers: [] }), activePrs: async () => [], escalations: async () => [] },
      {
        activeInstances: async () => roots,
        activeJobs: async () => [],
        // The waiting user task lives on the child instance 300; it must surface on root 200's floor.
        elements: async (key) => (key === '300' ? [{ elementInstanceKey: '900', processInstanceKey: '300', elementId: 'merge-approval', type: 'USER_TASK', state: 'ACTIVE', startDate: '2026-10-06T00:00:00Z' }] : []),
      },
    );
    await bridge.tick();
    const floors = (host.floors.mock.calls[0] as unknown as [{ id: string; issues: { title: string }[] }[]])[0];
    const dg = floors.find((f) => f.id.startsWith('delivery-graph'));
    expect(dg?.issues.some((i) => i.title.includes('Approve merge'))).toBe(true);
  });

  it('starts an issue from a text: default branch with confirmation, or a templated base', async () => {
    const { api, engine, host, bridge } = setup();
    expect(await bridge.answer('start acme/app#12')).toMatch(/handed to nano-workforce \(base main\)/);
    expect(api.startPlanFanout).toHaveBeenCalledWith({ issue: 'acme/app#12', baseBranch: 'main', confirmDefaultBase: true });
    await bridge.answer('start acme/app#13 on develop');
    expect(api.startPlanFanout).toHaveBeenLastCalledWith({ issue: 'acme/app#13', baseBranch: 'develop' });
    const b2 = new NanoBridge(api, engine, host, { url: '', pollMs: 1000, baseBranch: 'epic/issue-{n}' });
    expect(await b2.handOff('acme/app#7')).toBe('epic/issue-7');
    expect(api.startPlanFanout).toHaveBeenLastCalledWith({ issue: 'acme/app#7', baseBranch: 'epic/issue-7' });
    await expect(bridge.answer('start nonsense')).rejects.toThrow(/owner\/repo#123/);
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

describe('nanoAgentEnv', () => {
  it('exposes the url and secret under the names an ACP CEO\u2019s skill reads', () => {
    expect(nanoAgentEnv({ url: 'http://nwf:3000', secret: 's3cr3t' })).toEqual({ NANO_WORKFORCE_URL: 'http://nwf:3000', NANO_PR_WEBHOOK_SECRET: 's3cr3t' });
  });

  it('embeds Basic auth back into the url userinfo and omits a missing secret', () => {
    const auth = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    const env = nanoAgentEnv({ url: 'http://nwf:3000', auth });
    const u = new URL(env.NANO_WORKFORCE_URL);
    expect(u.username).toBe('user');
    expect(u.password).toBe('pass');
    expect(env.NANO_PR_WEBHOOK_SECRET).toBeUndefined();
  });

  it('leaves the url plain when there is no auth', () => {
    expect(nanoAgentEnv({ url: 'http://nwf:3000' })).toEqual({ NANO_WORKFORCE_URL: 'http://nwf:3000' });
  });
});
