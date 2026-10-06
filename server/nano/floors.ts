/**
 * The building as nano-workforce sees it: each live BPMN process instance (a convergence loop on a PR, a delivery
 * graph, a plan fan-out…) is a floor, its agent steps are the desks, and workers sit at the step whose job they hold.
 * Workers with no job wait on the bench (floor 1). What's waiting on a floor (escalations, user tasks, timers,
 * agent steps no worker has picked up yet) is on its whiteboard. Pure functions: the bridge feeds them engine + app data.
 */
import type { IssueInfo, NanoBoard, NanoEdge, NanoShape, PullInfo } from '../../shared/types.ts';
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
  /** Sequence flows: id → source and target element ids. */
  flows: Map<string, { source: string; target: string }>;
  /** The diagram (BPMN DI), when the model has one. */
  shapes: Map<string, { x: number; y: number; w: number; h: number }>;
  edges: Map<string, number[]>;
}

const NODE = /^(\w*[tT]ask|callActivity|subProcess|\w*Event|\w*Gateway|transaction)$/;

/** The agent steps, flow nodes, flows and diagram of a BPMN definition, in document order. */
export function parseProcess(xml: string): ProcessModel {
  const stations: Station[] = [];
  const elements = new Map<string, ElementInfo>();
  const flows = new Map<string, { source: string; target: string }>();
  const shapes = new Map<string, { x: number; y: number; w: number; h: number }>();
  const edges = new Map<string, number[]>();
  const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] ?? null;
  for (const m of xml.matchAll(/<(?:bpmn2?:)?(\w+)\b([^>]*?)(\/?)>/g)) {
    const [whole, kind, attrs, selfClosing] = m;
    const id = attr(attrs, 'id');
    if (!id) continue;
    if (kind === 'sequenceFlow') {
      const source = attr(attrs, 'sourceRef');
      const target = attr(attrs, 'targetRef');
      if (source && target) flows.set(id, { source, target });
      continue;
    }
    if (!NODE.test(kind) || kind === 'BPMNShape') continue;
    const name = decode(attr(attrs, 'name') ?? '');
    let jobType: string | null = null;
    if (!selfClosing) {
      const end = xml.indexOf(`</`, (m.index ?? 0) + whole.length);
      const close = new RegExp(`</(?:bpmn2?:)?${kind}>`).exec(xml.slice((m.index ?? 0) + whole.length));
      const inner = close ? xml.slice((m.index ?? 0) + whole.length, (m.index ?? 0) + whole.length + close.index) : xml.slice((m.index ?? 0) + whole.length, end);
      // A subprocess's own children are listed separately; only its direct task definition counts.
      if (!/subProcess/i.test(kind)) jobType = /taskDefinition\b[^>]*\btype="([^"]+)"/.exec(inner)?.[1] ?? null;
    }
    elements.set(id, { name: name || id, kind, jobType });
    if (jobType && isAgentJob(jobType)) stations.push({ elementId: id, name: (name || id).replace(/\s*\(agent\)\s*$/i, ''), jobType });
  }
  for (const m of xml.matchAll(/<(?:bpmndi:)?BPMNShape\b[^>]*?bpmnElement="([^"]+)"[^>]*>\s*<(?:dc|omgdc):Bounds\b([^>]*)\/>/g)) {
    const n = (k: string) => Number(new RegExp(`\\b${k}="([-\\d.]+)"`).exec(m[2])?.[1] ?? 0);
    shapes.set(m[1], { x: n('x'), y: n('y'), w: n('width'), h: n('height') });
  }
  for (const m of xml.matchAll(/<(?:bpmndi:)?BPMNEdge\b[^>]*?bpmnElement="([^"]+)"[^>]*>([\s\S]*?)<\/(?:bpmndi:)?BPMNEdge>/g)) {
    const pts: number[] = [];
    for (const w of m[2].matchAll(/waypoint\b[^>]*?x="([-\d.]+)"[^>]*?y="([-\d.]+)"/g)) pts.push(Number(w[1]), Number(w[2]));
    if (pts.length >= 4) edges.set(m[1], pts);
  }
  return { stations, elements, flows, shapes, edges };
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
  /** Its whiteboard: the process diagram, live. */
  board: NanoBoard;
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
  /** The bench's whiteboard: the whole fleet. */
  fleet: NanoBoard;
}

export interface WorldInput {
  supply: NanoSupply;
  prs: NanoPr[];
  escalations: NanoEscalation[];
  instances: EngineInstance[];
  jobs: EngineJob[];
  /** Element instances (every state) by root instance key. */
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
    const all = input.elements.get(inst.processInstanceKey) ?? [];
    for (const el of all.filter(isActive)) {
      const info = model?.elements.get(el.elementId);
      const name = el.elementName || info?.name || el.elementId;
      const key = Number(el.elementInstanceKey) || 0;
      if (/USER_TASK/i.test(el.type)) {
        if (escalations.some((e) => e.userTaskKey === el.elementInstanceKey)) continue; // this task's own escalation sticky says it better
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
      board: { kind: 'fleet', types: [], idle: [], offline: [], escalations: [], processes: [] }, // drawn below, once seats are known
    };
    floors.push(floor);
    byRoot.set(inst.processInstanceKey, floor);
  }

  const streamOf = (jobKey: string, corr: NanoCorrelation[]) => corr.find((c) => c.jobKey === jobKey)?.stream ?? null;
  const seats: Seat[] = input.supply.workers.map((w) => seatOf(w, input, roots, byRoot, streamOf));
  for (const f of floors) f.board = processBoard(f, input, seats);
  return { floors, seats, fleet: fleetBoard(floors, seats, input) };
}

const isActive = (e: EngineElement) => !e.state || e.state === 'ACTIVE';
const ms = (d: string | null | undefined) => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** A process floor's whiteboard: its BPMN diagram with where the tokens are, have been, and what's stuck. */
export function processBoard(f: Floor, input: WorldInput, seats: Seat[]): NanoBoard {
  const model = input.models.get(f.definitionKey);
  const els = input.elements.get(f.instanceKey) ?? [];
  const escalations = input.escalations.filter((e) => f.issues.some((i) => i.number === Number(e.userTaskKey)));
  const held = new Map<string, string[]>();
  for (const j of input.jobs) {
    const seat = seats.find((s) => s.instance === j.worker);
    if (seat?.floorId !== f.id) continue;
    held.set(j.elementId, [...(held.get(j.elementId) ?? []), seat.name]);
  }
  const shapes: NanoShape[] = [];
  for (const [id, b] of model?.shapes ?? []) {
    const info = model?.elements.get(id);
    if (!info) continue;
    const mine = els.filter((e) => e.elementId === id);
    const active = mine.filter(isActive);
    const workers = held.get(id) ?? [];
    const agent = !!info.jobType && isAgentJob(info.jobType);
    const waiting: NanoShape['waiting'] = !active.length
      ? null
      : /userTask/i.test(info.kind)
        ? active.some((e) => escalations.some((x) => x.userTaskKey === e.elementInstanceKey))
          ? 'escalation'
          : 'human'
        : /CatchEvent|receiveTask/i.test(info.kind)
          ? 'event'
          : agent && !workers.length
            ? 'queued'
            : null;
    const since = active.map((e) => ms(e.startDate)).filter((t): t is number => t !== null);
    shapes.push({
      id,
      name: info.name.replace(/\s*\(agent\)\s*$/i, ''),
      kind: info.kind,
      ...b,
      active: active.length,
      done: mine.filter((e) => e.state === 'COMPLETED').length,
      incident: mine.some((e) => e.hasIncident),
      agent,
      workers,
      waiting,
      since: since.length ? Math.min(...since) : null,
    });
  }
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const edges: NanoEdge[] = [];
  for (const [id, points] of model?.edges ?? []) {
    const flow = model?.flows.get(id);
    const from = flow && byId.get(flow.source);
    const to = flow && byId.get(flow.target);
    edges.push({ points, taken: !!from && !!to && from.done > 0 && to.done + to.active > 0 });
  }
  const xs = [...shapes.flatMap((s) => [s.x, s.x + s.w]), ...edges.flatMap((e) => e.points.filter((_, i) => i % 2 === 0))];
  const ys = [...shapes.flatMap((s) => [s.y, s.y + s.h]), ...edges.flatMap((e) => e.points.filter((_, i) => i % 2 === 1))];
  const x = xs.length ? Math.min(...xs) : 0;
  const y = ys.length ? Math.min(...ys) : 0;
  return {
    kind: 'process',
    process: f.processId,
    instanceKey: f.instanceKey,
    title: f.pulls[0] ? `${f.pulls[0].title}` : f.description.replace(/^⚠️ incident · /, ''),
    subtitle: f.pulls[0] ? `${f.processId} · ${f.description.replace(/^⚠️ incident · /, '').split(' · ').slice(0, 2).join(' · ')} · PR #${f.pulls[0].number}` : `${f.processId} · ${f.instanceKey}`,
    incident: f.incident,
    startedAt: ms(f.startedAt) ?? 0,
    bounds: { x, y, w: (xs.length ? Math.max(...xs) : 100) - x, h: (ys.length ? Math.max(...ys) : 100) - y },
    shapes,
    edges,
    escalations: escalations.map((e) => ({ ref: e.userTaskKey, label: `${e.kindLabel || e.kind}: ${e.question ?? e.subjectTitle}`.slice(0, 160) })),
  };
}

/** The bench's whiteboard: every agent job type with who holds one and what's queued, idle workers, escalations, processes. */
export function fleetBoard(floors: Floor[], seats: Seat[], input: WorldInput): NanoBoard {
  const types = new Map<string, Extract<NanoBoard, { kind: 'fleet' }>['types'][number]>();
  const type = (t: string) => {
    let row = types.get(t);
    if (!row) types.set(t, (row = { type: t, held: [], queued: [] }));
    return row;
  };
  for (const j of input.jobs) {
    if (!isAgentJob(j.type)) continue;
    const seat = seats.find((s) => s.instance === j.worker);
    const el = [...input.elements.values()].flat().find((e) => e.processInstanceKey === j.processInstanceKey && e.elementId === j.elementId && isActive(e));
    type(j.type).held.push({ worker: seat?.name ?? j.worker, floor: seat && seat.floorId !== BENCH ? seat.floorId : null, since: ms(el?.startDate) });
  }
  for (const f of floors) {
    if (f.board.kind !== 'process') continue;
    for (const s of f.board.shapes) {
      if (s.waiting !== 'queued') continue;
      const info = input.models.get(f.definitionKey)?.elements.get(s.id);
      if (info?.jobType) type(info.jobType).queued.push({ floor: f.id, step: s.name, since: s.since });
    }
  }
  return {
    kind: 'fleet',
    types: [...types.values()].sort((a, b) => b.queued.length - a.queued.length || b.held.length - a.held.length || a.type.localeCompare(b.type)),
    idle: seats.filter((s) => s.status === 'idle' && s.live).map((s) => ({ name: s.name, family: s.family })),
    offline: seats.filter((s) => !s.live).map((s) => s.name),
    escalations: input.escalations.map((e) => ({
      ref: e.userTaskKey,
      label: `${e.kindLabel || e.kind}: ${e.subjectTitle || e.question || ''}`.slice(0, 160),
      floor: floors.find((f) => f.issues.some((i) => i.number === Number(e.userTaskKey)))?.id ?? null,
    })),
    processes: floors.map((f) => ({
      floor: f.id,
      label: f.description,
      incident: f.incident,
      active: f.board.kind === 'process' ? f.board.shapes.filter((s) => s.active).map((s) => s.name) : [],
    })),
  };
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
