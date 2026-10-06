import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NanoBoard, NanoShape, RepoView } from '../../../shared/types';

// The screen-reader summary must carry every state the canvas paints, not just the highest-priority one.
// sfx and the canvas painter are mocked: both need a browser, and the store pulls sfx in.
vi.mock('./sfx', () => ({ alarm: vi.fn(), audioUnlocked: () => false, chirp: vi.fn(), cue: vi.fn() }));
vi.mock('../world/NanoBoard', () => ({ paintNanoBoard: vi.fn(), useMinute: () => 0 }));

const { NanoBoardView } = await import('./NanoBoardView');

const shape = (over: Partial<NanoShape>): NanoShape => ({
  id: 's1',
  name: 'Review',
  kind: 'serviceTask',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  active: 0,
  done: 0,
  incident: false,
  agent: true,
  workers: [],
  waiting: null,
  since: null,
  ...over,
});

const board = (shapes: NanoShape[]): NanoBoard => ({
  kind: 'process',
  process: 'p',
  instanceKey: 'k',
  title: 'Ship it',
  subtitle: 'round 1',
  incident: false,
  startedAt: 0,
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  shapes,
  edges: [],
  escalations: [],
});

const summary = (shapes: NanoShape[]) => renderToStaticMarkup(<NanoBoardView repo={{ nanoBoard: board(shapes) } as RepoView} />);

describe('the nano board screen-reader summary', () => {
  it('announces an incident step together with who holds it and its run counts', () => {
    // Regression (Copilot review): early returns announced only 'incident', hiding the workers and counts.
    const html = summary([shape({ incident: true, workers: ['Ada'], active: 2, done: 3 })]);
    expect(html).toContain('incident');
    expect(html).toContain('worker: Ada');
    // The canvas chips `● 2` for two active tokens; the summary must announce the count too (Copilot review).
    expect(html).toContain('active ×2');
    expect(html).toContain('done ×3');
  });

  it('says plain active for a single token', () => {
    const html = summary([shape({ active: 1 })]);
    expect(html).toContain('active');
    expect(html).not.toContain('active ×');
  });

  it('announces a waiting reason together with the worker holding the step', () => {
    const html = summary([shape({ workers: ['Bo'], waiting: 'escalation' })]);
    expect(html).toContain('worker: Bo');
    expect(html).toContain('waiting on you (escalation)');
  });

  it('still says not reached for a step with no state at all', () => {
    expect(summary([shape({})])).toContain('not reached');
  });
});
