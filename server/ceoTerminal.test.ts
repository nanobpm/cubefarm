import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

// Regression (Copilot review): the CEO's terminal flag must follow the harness that owns the live session,
// not the mutable "Runs on" setting. Switching the setting mid-session must not hide a still-running Claude
// terminal, nor reveal a stale terminal while an ACP session (whose steps are its log) is live.
describe('CEO terminal visibility follows the active session, not the setting', () => {
  function setup() {
    const swarm = new Swarm(createDemoBackend());
    (swarm as unknown as { ensureCeo(i: unknown[]): void }).ensureCeo([]);
    const priv = swarm as unknown as {
      state: { agents: { id: string; role: string }[]; settings: { ceoHarness: string }; ceo: { sessionHarness?: string } };
      agentRt: Map<string, { session: unknown; terminal: unknown }>;
    };
    const ceo = priv.state.agents.find((a) => a.role === 'ceo')!;
    const rt = priv.agentRt.get(ceo.id)!;
    rt.terminal = {}; // a real terminal exists
    const view = () => swarm.snapshot().agents.find((a) => a.id === ceo.id)!;
    return { priv, rt, view };
  }

  it('keeps a running Claude terminal visible after the setting flips to an ACP harness', () => {
    const { priv, rt, view } = setup();
    rt.session = {}; // a live session
    priv.state.ceo.sessionHarness = 'claude';
    priv.state.settings.ceoHarness = 'copilot'; // the manager switches "Runs on" mid-session
    expect(view().terminal).toBe(true);
  });

  it('hides a stale terminal when an ACP session is live and the setting flips back to Claude', () => {
    const { priv, rt, view } = setup();
    rt.session = {};
    priv.state.ceo.sessionHarness = 'copilot';
    priv.state.settings.ceoHarness = 'claude';
    expect(view().terminal).toBe(false);
  });

  it('follows the setting once no session is live', () => {
    const { priv, rt, view } = setup();
    rt.session = null;
    priv.state.ceo.sessionHarness = 'claude'; // stale from a prior session
    priv.state.settings.ceoHarness = 'copilot';
    expect(view().terminal).toBe(false);
    priv.state.settings.ceoHarness = 'claude';
    expect(view().terminal).toBe(true);
  });
});
