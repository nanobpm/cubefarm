import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The CEO's model field is harness-aware: Claude Code gets Claude suggestions; an ACP harness names its own
// models, so its field offers no datalist (a Claude list would send a Claude-only name to nano-coder/Copilot).
// sfx is mocked: it needs a browser, and the store pulls it in. The settings override prop keeps the field
// server-renderable: the store hook reads its creation-time snapshot under renderToStaticMarkup.
vi.mock('./sfx', () => ({ alarm: vi.fn(), audioUnlocked: () => false, chirp: vi.fn(), cue: vi.fn() }));

const { ModelInput } = await import('./AgentSettings');
const { useStore } = await import('../store');
type Agent = import('../store').Agent;
type SwarmSettings = import('../../../shared/types').SwarmSettings;

const ceo: Agent = {
  id: 'ceo',
  name: 'Boss',
  repoId: '',
  role: 'ceo',
  title: 'CEO',
  specialty: '',
  brief: '',
  hiredBy: 'manager',
  look: 'masculine',
  task: null,
  desk: 0,
  color: '#000',
  hair: '#000',
  skin: '#fff',
  style: null,
  model: '',
  effort: '',
  cli: '',
  terminal: true,
  status: 'idle',
  issueNumber: null,
  issueTitle: null,
  branch: null,
  prNumber: null,
  prUrl: null,
  currentTool: null,
  startedAt: null,
  endedAt: null,
  costUsd: 0,
  turns: 0,
  browserUrl: null,
  hasScreenshot: false,
  screenshotAt: null,
  lastError: null,
  career: null,
};

const settings = (ceoHarness: SwarmSettings['ceoHarness']): SwarmSettings => ({ ...useStore.getState().settings, ceoHarness });

const field = (harness: SwarmSettings['ceoHarness']) => renderToStaticMarkup(<ModelInput agent={ceo} settings={settings(harness)} />);

describe("the CEO's model field", () => {
  it('offers Claude model suggestions when the CEO runs Claude Code', () => {
    const html = field('claude');
    expect(html).toContain('claude-opus-5-5');
    expect(html).toContain('<option');
  });

  it.each(['nano-coder', 'copilot'] as const)('offers no Claude suggestions to an ACP CEO (%s)', (harness) => {
    const html = field(harness);
    expect(html).not.toContain('claude-opus-5-5');
    expect(html).not.toContain('<option');
  });
});
