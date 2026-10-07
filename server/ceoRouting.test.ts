import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { ceoResumeDecision, Swarm } from './swarm.ts';

// Regression (Copilot review): free-text phone routing (nanoCeo) must follow the harness that owns the
// live CEO session, not the mutable "Runs on" setting. Switching the setting mid-session must not divert a
// message away from a still-running ACP session (nor hand one to a finished one), matching agentView.
describe('CEO phone routing follows the active session, not the setting', () => {
  function setup() {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as { ensureCeo(i: unknown[]): void }).ensureCeo([]);
    const priv = swarm as unknown as {
      state: { agents: { id: string; role: string }[]; settings: { ceoHarness: string }; ceo: { sessionHarness?: string } };
      agentRt: Map<string, { session: unknown }>;
      nanoCeo(): boolean;
    };
    const ceo = priv.state.agents.find((a) => a.role === 'ceo')!;
    const rt = priv.agentRt.get(ceo.id)!;
    return { priv, rt };
  }

  it('routes to the live ACP session after the setting flips to Claude', () => {
    const { priv, rt } = setup();
    rt.session = {}; // a live session
    priv.state.ceo.sessionHarness = 'copilot';
    priv.state.settings.ceoHarness = 'claude'; // the manager switches "Runs on" mid-session
    expect(priv.nanoCeo()).toBe(true);
  });

  it('does not route to a live Claude session after the setting flips to an ACP harness', () => {
    const { priv, rt } = setup();
    rt.session = {};
    priv.state.ceo.sessionHarness = 'claude';
    priv.state.settings.ceoHarness = 'copilot';
    expect(priv.nanoCeo()).toBe(false);
  });

  it('follows the setting once no session is live', () => {
    const { priv, rt } = setup();
    rt.session = null;
    priv.state.ceo.sessionHarness = 'copilot'; // stale from a prior session
    priv.state.settings.ceoHarness = 'claude';
    expect(priv.nanoCeo()).toBe(false);
    priv.state.settings.ceoHarness = 'copilot';
    expect(priv.nanoCeo()).toBe(true);
  });

  // Regression (Copilot review 5436260674): between accepting a job and installing its session, `session` is
  // still null but the job already owns a harness (startingHarness). Routing must follow it so a "Runs on"
  // change landing in that startup window can't divert the phone to the wrong CEO.
  it('routes by the accepting ACP harness during startup, even after the setting flips to Claude', () => {
    const { priv, rt } = setup();
    rt.session = null; // not installed yet
    (rt as { startingHarness?: string }).startingHarness = 'copilot'; // the job that accepted ownership
    priv.state.settings.ceoHarness = 'claude'; // the manager flips the setting mid-startup
    expect(priv.nanoCeo()).toBe(true);
  });

  it('routes by the accepting Claude harness during startup, even after the setting flips to an ACP harness', () => {
    const { priv, rt } = setup();
    rt.session = null;
    (rt as { startingHarness?: string }).startingHarness = 'claude';
    priv.state.settings.ceoHarness = 'copilot';
    expect(priv.nanoCeo()).toBe(false);
  });
});

// Regression (Copilot review): a chat queued while an ACP harness was selected must not be dequeued after the
// manager switches "Runs on" back to Claude — runCeoJob would launch it as Claude and the nano backend would
// answer with the scripted demo session. startCeoWork re-validates the queue against the current nano CEO mode.
describe('nano CEO queue revalidation', () => {
  function setup() {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as { ensureCeo(i: unknown[]): void }).ensureCeo([]);
    const priv = swarm as unknown as {
      state: {
        agents: { id: string; role: string; status: string }[];
        settings: { ceoHarness: string; sessionLimit: number };
        ceo: { queue: { kind: string; text?: string; at: number }[]; job: unknown; sessionHarness?: string };
      };
      agentRt: Map<string, { session: unknown }>;
      nano: unknown;
      startCeoWork(): void;
    };
    const ceo = priv.state.agents.find((a) => a.role === 'ceo')!;
    const rt = priv.agentRt.get(ceo.id)!;
    return { priv, ceo, rt };
  }

  it('drops a queued chat once "Runs on" is Claude again', () => {
    const { priv, rt } = setup();
    priv.nano = {}; // nano mode
    priv.state.settings.sessionLimit = 0; // no slot cap
    rt.session = null;
    priv.state.settings.ceoHarness = 'claude'; // switched back after the chat was queued
    priv.state.ceo.queue.push({ kind: 'chat', text: 'status?', at: Date.now() });
    priv.startCeoWork();
    expect(priv.state.ceo.queue).toHaveLength(0);
    expect(priv.state.ceo.job).toBeNull();
  });

  it('keeps a queued chat while an ACP harness is selected', () => {
    const { priv, ceo, rt } = setup();
    priv.nano = {};
    rt.session = null;
    priv.state.settings.ceoHarness = 'copilot';
    ceo.status = 'working'; // busy: revalidation runs but no session is launched
    priv.state.ceo.queue.push({ kind: 'chat', text: 'status?', at: Date.now() });
    priv.startCeoWork();
    expect(priv.state.ceo.queue.some((j) => j.kind === 'chat')).toBe(true);
  });
});

// Regression (Copilot review): agent_detail used to hard-code the CEO's codingAgent/model/effort as Claude's, so an
// ACP CEO (or anyone inspecting it) read the wrong runtime configuration. It now follows the "Runs on" harness.
describe('agent_detail reports the CEO harness, not always Claude', () => {
  function setup() {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as { ensureCeo(i: unknown[]): void }).ensureCeo([]);
    const priv = swarm as unknown as {
      state: { agents: { id: string; role: string; model: string; effort: string }[]; settings: { ceoHarness: string; defaultEffort: string } };
      agentDetail(x: { agent_id: string }): string;
    };
    const ceo = priv.state.agents.find((a) => a.role === 'ceo')!;
    return { priv, ceo, detail: () => JSON.parse(priv.agentDetail({ agent_id: ceo.id })) as { codingAgent: string; model: string; effort: string } };
  }

  it('reports Claude Code and its defaults on the Claude harness', () => {
    const { priv, ceo, detail } = setup();
    priv.state.settings.ceoHarness = 'claude';
    ceo.model = '';
    ceo.effort = '';
    expect(detail()).toMatchObject({ codingAgent: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' });
  });

  it('reports the ACP harness and its own default for an empty model', () => {
    const { priv, ceo, detail } = setup();
    priv.state.settings.ceoHarness = 'nano-coder';
    ceo.model = '';
    ceo.effort = '';
    const d = detail();
    expect(d.codingAgent).toBe('nano-coder');
    expect(d.model).toBe('the harness default');
    expect(d.effort).toBe(''); // ACP sessions ignore effort (acpArgs passes none), so nothing is invented
  });

  it('reports the configured ACP model when one is set', () => {
    const { priv, ceo, detail } = setup();
    priv.state.settings.ceoHarness = 'copilot';
    ceo.model = 'github-copilot/kimi-k3';
    expect(detail().model).toBe('github-copilot/kimi-k3');
  });

  // Regression (adversarial review): the harness-aware effort rewrite dropped the dev/QA fallback — a non-CEO
  // agent with no explicit effort (the common case; hireAgent stores '') read '' instead of defaultEffort.
  it('still reports the office default effort for a dev with none set', async () => {
    const swarm = new Swarm(createDemoBackend());
    const repo = await swarm.connectRepo('demo-co/pixel-todo');
    const priv = swarm as unknown as {
      state: { settings: { defaultEffort: string } };
      agentDetail(x: { agent_id: string }): string;
    };
    priv.state.settings.defaultEffort = 'high';
    const dev = swarm.hireAgent(repo.id, {});
    const d = JSON.parse(priv.agentDetail({ agent_id: dev.id })) as { effort: string };
    expect(d.effort).toBe('high');
  });
});

// Regression (Copilot review 5434797552): when "Runs on" changes harness, the old harness's resumable session id
// is stale. Leaving it on the agent while sessionHarness is reassigned meant a new session that failed before its
// sessionId callback persisted that foreign id under the new harness, and the next chat sent it to the wrong
// session/load. ceoResumeDecision must clear the stored id (and never resume) across an ownership change.
describe('ceoResumeDecision drops a stale session id when the harness changes', () => {
  it('resumes only when the same harness still owns the session', () => {
    expect(ceoResumeDecision('chat', 'copilot', 'copilot', 'sess-1')).toEqual({ resume: 'sess-1', clearStored: false });
  });

  it('clears the stored id and does not resume when the harness changes', () => {
    // The cited bug: copilot -> claude (or any switch) must drop the foreign id so a failed startup can't
    // persist it under the new harness.
    expect(ceoResumeDecision('chat', 'copilot', 'claude', 'sess-1')).toEqual({ resume: undefined, clearStored: true });
    expect(ceoResumeDecision('chat', 'claude', 'nano-coder', 'sess-1')).toEqual({ resume: undefined, clearStored: true });
  });

  it('never resumes a non-chat job, even on the same harness', () => {
    expect(ceoResumeDecision('review', 'claude', 'claude', 'sess-1')).toEqual({ resume: undefined, clearStored: false });
  });

  it('resumes nothing and clears nothing when there is no stored id', () => {
    expect(ceoResumeDecision('chat', 'claude', 'claude', null)).toEqual({ resume: undefined, clearStored: false });
  });
});

// Regression (Copilot review 5434988423): runCeoJob used to read the harness (and model) only after awaiting
// fs.mkdir, so a "Runs on" change landing in that window launched the job on the newly selected harness rather
// than the one that accepted it. The capture must happen before the first await, so the session belongs to the
// accepting harness no matter when the setting flips.
describe('runCeoJob captures the harness before any await', () => {
  it('launches on the harness that accepted the job even when the setting flips mid-startup', async () => {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as { ensureCeo(i: unknown[]): void }).ensureCeo([]);
    const priv = swarm as unknown as {
      state: { agents: { id: string; role: string; model: string }[]; settings: { ceoHarness: string } };
      backend: { startSession(o: unknown, c: unknown): unknown };
      runCeoJob(a: unknown, job: unknown): Promise<void>;
    };
    const ceo = priv.state.agents.find((a) => a.role === 'ceo')!;
    ceo.model = ''; // fall back to the harness default so the launched model reveals the captured harness
    let launched: { model?: string } | undefined;
    const orig = priv.backend.startSession.bind(priv.backend);
    priv.backend.startSession = (o: unknown, c: unknown) => {
      launched = o as { model?: string };
      return orig(o, c);
    };
    priv.state.settings.ceoHarness = 'claude'; // the harness that accepts the job
    const p = priv.runCeoJob(ceo, { kind: 'chat', text: 'hi', at: Date.now() });
    priv.state.settings.ceoHarness = 'copilot'; // the manager switches "Runs on" while startup is awaiting
    await p;
    // Claude's default model, not the ACP pass-through (''), proves the pre-await capture won the race.
    expect(launched?.model).toBe('claude-opus-5-5');
  });

  // Regression (Copilot review 5436260674): the accepting harness must own routing through the whole startup
  // window (before `session` exists), and the startup marker must be cleared once the session installs.
  it('routes by the accepting harness while startup is installing the session, then clears the marker', async () => {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as { ensureCeo(i: unknown[]): void }).ensureCeo([]);
    const priv = swarm as unknown as {
      state: { agents: { id: string; role: string }[]; settings: { ceoHarness: string } };
      agentRt: Map<string, { session: unknown; startingHarness?: string | null }>;
      backend: { startSession(o: unknown, c: unknown): unknown };
      runCeoJob(a: unknown, job: unknown): Promise<void>;
      nanoCeo(): boolean;
    };
    const ceo = priv.state.agents.find((a) => a.role === 'ceo')!;
    const rt = priv.agentRt.get(ceo.id)!;
    priv.state.settings.ceoHarness = 'copilot'; // the harness that accepts the job
    let nanoWhileInstalling: boolean | undefined;
    const orig = priv.backend.startSession.bind(priv.backend);
    priv.backend.startSession = (o: unknown, c: unknown) => {
      priv.state.settings.ceoHarness = 'claude'; // the manager flips "Runs on" just before the session installs
      nanoWhileInstalling = priv.nanoCeo(); // session not yet assigned: must still follow the ACP starting harness
      return orig(o, c);
    };
    await priv.runCeoJob(ceo, { kind: 'chat', text: 'hi', at: Date.now() });
    expect(nanoWhileInstalling).toBe(true); // on old code this read the flipped setting and returned false
    expect(rt.startingHarness ?? null).toBe(null); // the marker is cleared once the session owns routing
  });
});
