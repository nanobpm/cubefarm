/**
 * The office's Backend in nano mode: its "repos" are nano-workforce's live process instances (server/nano/floors.ts),
 * served from what the bridge last saw. Nothing is cloned or run here, and the office can't change GitHub: nano-workforce
 * does the work. The rest (voice, weather, previews, the office host…) is the demo backend's harmless stand-ins.
 */
import type { Backend } from '../backend.ts';
import { createDemoBackend } from '../demo.ts';
import type { RepoMeta } from '../github.ts';
import { BENCH, type Floor } from './floors.ts';

/** The floors the bridge last saw, by id; it keeps this current. */
export class FloorBook {
  private floors = new Map<string, Floor>();

  set(list: Floor[]) {
    this.floors = new Map(list.map((f) => [f.id.toLowerCase(), f]));
  }

  get(id: string): Floor | undefined {
    return this.floors.get(id.toLowerCase());
  }

  all(): Floor[] {
    return [...this.floors.values()];
  }
}

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`nano-workforce runs this office's work: ${what} happens there (its cockpit or c8ctl), not here.`);
};

export function createNanoBackend(book: FloorBook, appUrl: string): Backend {
  const demo = createDemoBackend(null);
  const meta = (fullName: string): RepoMeta => {
    if (fullName.toLowerCase() === BENCH) return { nameWithOwner: BENCH, description: 'Workers waiting for a job', url: appUrl, defaultBranch: 'main' };
    const f = book.get(fullName);
    if (!f) throw new Error(`${fullName} is not a running nano-workforce process`);
    return { nameWithOwner: f.id, description: f.description, url: f.url || appUrl, defaultBranch: 'main' };
  };
  const backend: Backend = {
    ...demo,
    demo: false,
    demoCandidate: undefined,
    demoTeam: undefined,
    demoDoctor: undefined,
    seedOps: undefined,
    simulateUsage: undefined,
    user: async () => 'nano-workforce',
    listMyRepos: async () => book.all().map((f) => ({ nameWithOwner: f.id, description: f.description, visibility: 'PRIVATE', updatedAt: f.startedAt })),
    repoMeta: async (fullName) => meta(fullName),
    listIssues: async (fullName) => [...(book.get(fullName)?.issues ?? [])],
    listPulls: async (fullName) => [...(book.get(fullName)?.pulls ?? [])],
    issueState: async (fullName, n) => (book.get(fullName)?.issues.some((i) => i.number === n) ? 'OPEN' : 'CLOSED'),
    issueDetails: async (fullName, n) => {
      const i = book.get(fullName)?.issues.find((x) => x.number === n);
      if (!i) throw new Error(`#${n} is not waiting on ${fullName}`);
      return { title: i.title, body: i.body, createdAt: i.createdAt };
    },
    prDetails: async (fullName, n) => {
      const p = book.get(fullName)?.pulls.find((x) => x.number === n);
      if (!p) throw new Error(`PR #${n} is not on ${fullName}`);
      return { ...p, body: '', isCrossRepository: false, checkNames: [], failedChecks: [], pendingChecks: [] };
    },
    prForBranch: async () => null,
    createIssue: refuse('filing issues'),
    editIssue: refuse('editing issues'),
    closeIssue: refuse('closing issues'),
    mergePull: refuse('merging'),
    updateBranch: refuse('updating branches'),
    rerunFailedJobs: refuse('re-running checks'),
    closePull: refuse('closing PRs'),
    commentPull: refuse('commenting'),
    publishFolder: refuse('publishing folders'),
    createProject: refuse('creating projects'),
    scanProjects: async () => [],
    ensureClone: async () => undefined,
    syncMain: async () => null,
  };
  return backend;
}
