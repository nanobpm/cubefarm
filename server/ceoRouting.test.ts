import { describe, expect, it } from 'vitest';
import { createDemoBackend } from './demo.ts';
import { Swarm } from './swarm.ts';

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
});
