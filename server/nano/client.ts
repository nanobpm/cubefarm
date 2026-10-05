/**
 * The nano-workforce app's HTTP API (its `/app/api` surface, see nano-workforce's openapi.yaml): the few reads the
 * office mirrors and the two actions it drives. Only the fields cubefarm uses are typed.
 */

export interface NanoWorker {
  instance: string;
  identity: string;
  stream: string;
  family?: string;
  host?: string;
  jobKeys: string[];
  live: boolean;
  staleMs: number;
}

export interface NanoCorrelation {
  jobKey: string;
  stream: string;
  processInstanceKey?: string;
  bpmnProcessId?: string;
  elementId?: string;
  planKey?: string; // owner/repo#123
}

export interface NanoSupply {
  workers: NanoWorker[];
  correlations?: NanoCorrelation[];
}

export interface NanoPr {
  prKey: string;
  repo: string; // owner/repo
  number: number;
  url: string;
  title: string | null;
  status: string;
  round: number;
  activeWorker: string | null;
  openEscalation: { userTaskKey: string; kind: string; summary: string | null } | null;
  updatedAt: string;
}

export interface NanoEscalation {
  userTaskKey: string;
  kind: string;
  kindLabel: string;
  prKey: string | null;
  subjectType: string;
  subjectKey: string;
  subjectTitle: string;
  subjectUrl: string | null;
  question: string | null;
  formKey: string | null;
  processKey: string | null;
  formVariables: Record<string, unknown>;
}

export interface NanoTranscript {
  status: 'open' | 'completed';
  nextOffset: number;
  entries: { offset: number; chunk: string }[];
}

export interface NanoApi {
  supply(): Promise<NanoSupply>;
  activePrs(): Promise<NanoPr[]>;
  escalations(): Promise<NanoEscalation[]>;
  transcript(stream: string, from: number): Promise<NanoTranscript | null>;
  startPlanFanout(body: { issue: string; baseBranch: string; confirmDefaultBase?: boolean }): Promise<unknown>;
  completeUserTask(userTaskKey: string, variables: Record<string, unknown>): Promise<unknown>;
}

export class NanoError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** `base` is the app's origin (http://localhost:3000) or its console-proxy URL; `/app/api` is added. */
export function nanoClient(base: string, opts: { secret?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): NanoApi {
  const root = `${base.replace(/\/+$/, '').replace(/\/app\/api$/, '')}/app/api`;
  const doFetch = opts.fetch ?? fetch;
  const call = async <T>(method: 'GET' | 'POST', p: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.secret) headers['x-hook-secret'] = opts.secret;
    const res = await doFetch(`${root}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const o = json as { error?: unknown; message?: unknown } | null;
      const msg = typeof o?.error === 'string' ? o.error : typeof o?.message === 'string' ? o.message : text.slice(0, 300);
      throw new NanoError(res.status, `nano-workforce ${method} ${p}: ${res.status} ${msg}`);
    }
    return json as T;
  };
  return {
    supply: () => call<NanoSupply>('GET', '/agentic/supply'),
    activePrs: async () => (await call<{ prs?: NanoPr[] }>('GET', '/status')).prs ?? [],
    escalations: async () => (await call<{ escalations?: NanoEscalation[] }>('GET', '/escalations')).escalations ?? [],
    transcript: async (stream, from) => {
      try {
        return await call<NanoTranscript>('GET', `/agentic/transcripts?stream=${encodeURIComponent(stream)}&from=${from}`);
      } catch (err) {
        if (err instanceof NanoError && err.status === 404) return null;
        throw err;
      }
    },
    startPlanFanout: (body) => call('POST', '/actions/start/plan-fanout', body),
    completeUserTask: (userTaskKey, variables) => call('POST', '/actions/complete-user-task', { userTaskKey, variables, operator: 'cubefarm' }),
  };
}
