/**
 * The building as nano-workforce sees it: each live BPMN process instance (a convergence loop on a PR, a delivery
 * graph, a plan fan-out…) is a floor, its agent steps are the desks, and workers sit at the step whose job they hold.
 * Workers with no job wait on the bench (floor 1). What's waiting on a floor (escalations, user tasks, timers,
 * agent steps no worker has picked up yet) is on its whiteboard. Pure functions: the bridge feeds them engine + app data.
 */
import type { IssueInfo, PullInfo } from '../../shared/types.ts';
import type { EngineElement, EngineInstance, EngineJob, NanoCorrelation, NanoEscalation, NanoPr, NanoSupply, NanoWorker } from './client.ts';
import { workerName } from './mirror.ts';

/** The floor idle workers wait on. Always floor 1. */
export const BENCH = 'nano-workforce/bench';

/** A BPMN step an agent works on (a service task whose job type is pool:capability, e.g. senior:pr-review). */
export interface Station {
  elementId: string;
  name: string;
  jobType: string;
}

/** A BPMN element of a definition, by id: its name and kind (for what's waiting on the whiteboard). */
export interface ElementInfo {
  name: string;
  kind: string; // serviceTask, userTask, intermediateCatchEvent…
  jobType: string | null;
}

export interface ProcessModel {
  stations: Station[];
  elements: Map<string, ElementInfo>;
}

/** The agent steps and named elements of a BPMN definition, in document order. */
export function parseProcess(xml: string): ProcessModel {
  const stations: Station[] = [];
  const elements = new Map<string, ElementInfo>();
  const re = /<(?:bpmn:)?(\w*[tT]ask|callActivity|subProcess|\w*CatchEvent)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:bpmn:)?\1>)/g;
  const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] ?? null;
  for (const m of xml.matchAll(re)) {
    const [, kind, attrs, , inner = ''] = m;
    const id = attr(attrs, 'id');
    if (!id) continue;
    const name = decode(attr(attrs, 'name') ?? id);
    const jobType = /taskDefinition\b[^>]*\btype="([^"]+)"/.exec(inner)?.[1] ?? null;
    elements.set(id, { name, kind, jobType });
    if (jobType && isAgentJob(jobType)) stations.push({ elementId: id, name: name.replace(/\s*\(agent\)\s*$/i, ''), jobType });
    // A subprocess's own children are matched separately by the outer loop only when not nested; scan them too.
    if (/^subProcess$/i.test(kind)) for (const [k, v] of parseProcess(inner).elements) elements.set(k, v);
  }
  return { stations, elements };
}

/** Agent work is a pool:capability job type (senior:pr-review); the engine's plumbing is dotted (pr.finalize). */
export function isAgentJob(type: string): boolean {
  return /^[\w-]+:[\w.-]+$/.test(type);
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#10;/g, ' ');

/** A floor: one live process instance. */
export interface Floor {
  id: string; // owner/name, as cubefarm's floors are repos: <process id>/<subject>
  instanceKey: string;
  definitionKey: string;
  processId: string;
  description: string;
  url: string;
  stations: Station[];
  issues: IssueInfo[];
  pulls: PullInfo[];
  startedAt: string;
  incident: boolean;
}

/** Where a worker is and what it's doing. */
export interface Seat {
  instance: string;
  name: string;
  family: string;
  floorId: string;
  /** The desk of its station, or null: any free desk. */
  desk: number | null;
  status: 'working' | 'idle';
  task: 'issue' | 'fix';
  doing: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  prNumber: number | null;
  prUrl: string | null;
  stream: string | null;
  live: boolean;
}

export interface World {
  floors: Floor[];
  seats: Seat[];
}

export interface WorldInput {
  supply: NanoSupply;
  prs: NanoPr[];
  escalations: NanoEscalation[];
  instances: EngineInstance[];
  jobs: EngineJob[];
  /** Active elements by root instance key. */
  elements: Map<string, EngineElement[]>;
  /** BPMN models by definition key (those not fetched yet are missing: no stations yet). */
  models: Map<string, ProcessModel>;
  /** Floor ids already given to instances: a floor keeps its name. */
  names: Map<string, string>;
  /** The engine's operate/console URL for an instance, if known. */
  instanceUrl?: (key: string) => string;
}

/** The root of each instance (call activities run as child instances). */
export function rootsOf(instances: EngineInstance[]): Map<string, string> {
  const byKey = new Map(instances.map((i) => [i.processInstanceKey, i]));
  const roots = new Map<string, string>();
  for (const i of instances) {
    let r = i;
    for (let hops = 0; r.parentProcessInstanceKey && byKey.has(r.parentProcessInstanceKey) && hops < 20; hops++) r = byKey.get(r.parentProcessInstanceKey)!;
    roots.set(i.processInstanceKey, r.processInstanceKey);
  }
  return roots;
}

const slug = (s: string, max = 40) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'x';

/** The floor id for a root instance: convergence-loop/nano-supervisor-pr47, delivery-graph/54bde3dae2fa… */
export function floorId(inst: EngineInstance, pr: NanoPr | undefined): string {
  const pid = inst.processDefinitionId;
  const hash = /^(.*?)-([0-9a-f]{8,})$/i.exec(pid);
  const owner = slug(hash ? hash[1] : pid, 30);
  const name = pr ? `${pr.repo.split('/')[1] ?? pr.repo}-pr${pr.number}` : hash ? hash[2] : inst.processInstanceKey;
  return `${owner}/${slug(name)}`;
}

/** Where every worker is, and the floors they're on. */
export function buildWorld(input: WorldInput): World {
  const roots = rootsOf(input.instances);
  const rootInstances = input.instances.filter((i) => roots.get(i.processInstanceKey) === i.processInstanceKey);
  const prOf = (root: string) => input.prs.find((p) => p.processKey && roots.get(p.processKey) === root);
  const floors: Floor[] = [];
  const byRoot = new Map<string, Floor>();
  const heldJobs = new Set(input.jobs.map((j) => `${j.processInstanceKey}/${j.elementId}`));

  for (const inst of rootInstances.sort((a, b) => a.startDate.localeCompare(b.startDate))) {
    const pr = prOf(inst.processInstanceKey);
    let id = input.names.get(inst.processInstanceKey);
    if (!id) {
      id = floorId(inst, pr);
      if (floors.some((f) => f.id === id) || id === BENCH) id = `${id}-${inst.processInstanceKey}`;
      input.names.set(inst.processInstanceKey, id);
    }
    const model = input.models.get(inst.processDefinitionKey);
    const escalations = input.escalations.filter((e) => e.processKey && (roots.get(e.processKey) ?? e.processKey) === inst.processInstanceKey);
    const subject = escalations.find((e) => e.subjectTitle)?.subjectTitle;
    const issues: IssueInfo[] = escalations.map((e) => ({
      number: Number(e.userTaskKey) || 0,
      title: `🚨 ${e.kindLabel || e.kind}: ${e.question ?? e.subjectTitle}`.slice(0, 200),
      body: `${e.question ?? ''}\n\nAnswer on the phone: answer ${e.userTaskKey} …`,
      url: e.subjectUrl ?? '',
      labels: ['needs-human', e.kind],
      createdAt: inst.startDate,
    }));
    // What else is waiting: user tasks and timers, and agent steps no worker has taken yet.
    for (const el of input.elements.get(inst.processInstanceKey) ?? []) {
      const info = model?.elements.get(el.elementId);
      const name = el.elementName || info?.name || el.elementId;
      const key = Number(el.elementInstanceKey) || 0;
      if (/USER_TASK/i.test(el.type)) {
        if (escalations.length) continue; // the escalation sticky says it better
        issues.push({ number: key, title: `🙋 ${name}`, body: 'A person has to complete this step.', url: '', labels: ['waiting', 'user-task'], createdAt: inst.startDate });
      } else if (/CATCH_EVENT|RECEIVE_TASK/i.test(el.type)) {
        issues.push({ number: key, title: `⏳ ${name}`, body: 'Waiting for an event or timer.', url: '', labels: ['waiting'], createdAt: inst.startDate });
      } else if (info?.jobType && isAgentJob(info.jobType) && !heldJobs.has(`${el.processInstanceKey}/${el.elementId}`)) {
        issues.push({ number: key, title: `🕒 ${name}: no worker yet (${info.jobType})`, body: `Queued for a ${info.jobType} worker.`, url: '', labels: ['queued'], createdAt: inst.startDate });
      }
    }
    const floor: Floor = {
      id,
      instanceKey: inst.processInstanceKey,
      definitionKey: inst.processDefinitionKey,
      processId: inst.processDefinitionId,
      description: ((inst.hasIncident ? '⚠️ incident · ' : '') + (pr ? `${pr.status} · round ${pr.round}${pr.title ? ` · ${pr.title}` : ''}` : (subject ?? inst.processDefinitionName ?? inst.processDefinitionId))).slice(0, 200),
      url: pr?.url ?? input.instanceUrl?.(inst.processInstanceKey) ?? '',
      stations: model?.stations ?? [],
      issues,
      pulls: pr ? [pullOf(pr)] : [],
      startedAt: inst.startDate,
      incident: !!inst.hasIncident,
    };
    floors.push(floor);
    byRoot.set(inst.processInstanceKey, floor);
  }

  const streamOf = (jobKey: string, corr: NanoCorrelation[]) => corr.find((c) => c.jobKey === jobKey)?.stream ?? null;
  const seats: Seat[] = input.supply.workers.map((w) => seatOf(w, input, roots, byRoot, streamOf));
  return { floors, seats };
}

function seatOf(
  w: NanoWorker,
  input: WorldInput,
  roots: Map<string, string>,
  byRoot: Map<string, Floor>,
  streamOf: (jobKey: string, c: NanoCorrelation[]) => string | null,
): Seat {
  const base: Seat = {
    instance: w.instance,
    name: workerName(w),
    family: [w.family, w.host].filter(Boolean).join(' @ ').slice(0, 60),
    floorId: BENCH,
    desk: null,
    status: 'idle',
    task: 'issue',
    doing: null,
    issueNumber: null,
    issueTitle: null,
    prNumber: null,
    prUrl: null,
    stream: null,
    live: w.live,
  };
  // Its job: the engine says which (by worker name), else the app's own record of the keys it holds.
  const job = input.jobs.find((j) => j.worker === w.instance) ?? input.jobs.find((j) => w.jobKeys.includes(j.jobKey));
  const jobKey = job?.jobKey ?? w.jobKeys[0];
  if (!jobKey) return base;
  base.status = 'working';
  base.stream = streamOf(jobKey, input.supply.correlations ?? []);
  const floor = job ? byRoot.get(roots.get(job.processInstanceKey) ?? job.processInstanceKey) : undefined;
  if (!job || !floor) {
    base.doing = job ? `${job.type} (job ${jobKey})` : `job ${jobKey}`;
    return base;
  }
  base.floorId = floor.id;
  const station = floor.stations.findIndex((s) => s.elementId === job.elementId);
  base.desk = station >= 0 ? station : null;
  const name = floor.stations[station]?.name ?? input.models.get(floor.definitionKey)?.elements.get(job.elementId)?.name ?? job.elementId;
  base.doing = name;
  const pr = floor.pulls[0];
  if (pr) {
    Object.assign(base, { task: 'fix', prNumber: pr.number, prUrl: pr.url });
  } else {
    base.issueTitle = floor.description;
  }
  return base;
}

function pullOf(pr: NanoPr): PullInfo {
  return {
    number: pr.number,
    title: pr.title ?? `${pr.repo}#${pr.number}`,
    url: pr.url,
    headRefName: '',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'UNKNOWN',
    reviewDecision: pr.openEscalation ? 'CHANGES_REQUESTED' : null,
    closesIssues: [],
    createdAt: pr.updatedAt,
    mergedAt: null,
    additions: 0,
    deletions: 0,
    checks: 'none',
    headSha: '',
    mergeState: 'UNKNOWN',
    failedChecks: [],
    pendingChecks: [],
  };
}
