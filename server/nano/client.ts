import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

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

/**
 * DNS for the app's host, without unscoped link-local IPv6 (fe80::). mDNS names (merlin.local) often resolve to one
 * first, and Node then gives up with EHOSTUNREACH instead of trying the IPv4 address.
 */
const lookup: NonNullable<http.RequestOptions['lookup']> = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (cb as (e: Error) => void)(err);
    const list = (addresses as dns.LookupAddress[]).filter((a) => !(a.family === 6 && /^fe80:/i.test(a.address) && !a.address.includes('%')));
    const usable = list.length ? list : (addresses as dns.LookupAddress[]);
    if ((options as dns.LookupOptions).all) return (cb as (e: null, a: dns.LookupAddress[]) => void)(null, usable);
    (cb as (e: null, a: string, f: number) => void)(null, usable[0].address, usable[0].family);
  });
};

/** A minimal fetch over node:http(s) with that lookup: what the client uses unless it's given one. */
export const nodeFetch = ((url: string, init: RequestInit = {}) =>
  new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: init.method ?? 'GET', headers: init.headers as Record<string, string>, lookup, signal: init.signal ?? undefined },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve(new Response(Buffer.concat(parts), { status: res.statusCode ?? 0 })));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body as string);
    req.end();
  })) as unknown as typeof fetch;

/** `base` is the app's origin (http://localhost:3000) or its console-proxy URL; `/app/api` is added. */
export function nanoClient(base: string, opts: { secret?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): NanoApi {
  const root = `${base.replace(/\/+$/, '').replace(/\/app\/api$/, '')}/app/api`;
  const doFetch = opts.fetch ?? nodeFetch;
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
