/**
 * Pure mapping from nano-workforce's state onto the office: which worker sits on which floor doing what, how its
 * escalations read on the manager's phone, and how a texted reply becomes a completed user task.
 */
import type { AgentStatus, AgentTask } from '../../shared/types.ts';
import type { NanoCorrelation, NanoEscalation, NanoPr, NanoSupply, NanoWorker } from './client.ts';

/** owner/repo#123 (or an issue / PR URL) → its parts; null when it's neither. */
export function parseRef(ref: string | undefined | null): { repo: string; number: number } | null {
  if (!ref) return null;
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim()) ?? /github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/.exec(ref);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** Where a worker is and what it's on, as the office shows it. */
export interface Seat {
  instance: string;
  name: string;
  /** The floor's repo id; null: not on any connected floor's work (it stays where it last was). */
  repoId: string | null;
  status: AgentStatus;
  task: AgentTask | null;
  issueNumber: number | null;
  issueTitle: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The relay stream its terminal rides (job:<jobKey> while busy). */
  stream: string | null;
  /** What it's doing, in a few words (the BPMN step). */
  doing: string | null;
  live: boolean;
}

const FIX_STEPS = /pr-review|review|fix-ci|rebase|trial-merge|converge|merge/i;

/** A human name for a worker from its identity (e.g. "fleet/copilot-2" → "copilot-2"). */
export function workerName(w: NanoWorker): string {
  const raw = (w.identity || w.instance).split(/[/:@]/).filter(Boolean).pop() ?? w.instance;
  return raw.slice(0, 24);
}

/** The repo id on a connected floor for `repo`, matched case-insensitively. */
function floorId(repo: string, repoIds: readonly string[]): string | null {
  return repoIds.find((id) => id.toLowerCase() === repo.toLowerCase()) ?? null;
}

export function seatsFor(supply: NanoSupply, prs: readonly NanoPr[], repoIds: readonly string[]): Seat[] {
  const corr = new Map<string, NanoCorrelation>();
  for (const c of supply.correlations ?? []) corr.set(c.jobKey, c);
  return supply.workers.map((w) => {
    const job = w.jobKeys.map((k) => corr.get(k) ?? { jobKey: k, stream: `job:${k}` })[0] ?? null;
    const seat: Seat = {
      instance: w.instance,
      name: workerName(w),
      repoId: null,
      status: !w.live ? 'stopped' : job ? 'working' : 'idle',
      task: null,
      issueNumber: null,
      issueTitle: null,
      prNumber: null,
      prUrl: null,
      stream: job ? job.stream || `job:${job.jobKey}` : null,
      doing: job ? [job.bpmnProcessId, job.elementId].filter(Boolean).join(' · ') || 'working' : null,
      live: w.live,
    };
    if (!job) return seat;
    const step = `${job.bpmnProcessId ?? ''} ${job.elementId ?? ''}`;
    seat.task = FIX_STEPS.test(step) ? 'fix' : 'issue';
    // The PR it holds a lease on, else the plan / epic its job belongs to.
    const pr = prs.find((p) => p.activeWorker === w.instance || p.activeWorker === w.identity);
    const ref = pr ? { repo: pr.repo, number: pr.number } : parseRef(job.planKey);
    if (ref) seat.repoId = floorId(ref.repo, repoIds);
    if (pr) {
      seat.prNumber = pr.number;
      seat.prUrl = pr.url;
      seat.issueTitle = pr.title;
    } else if (ref) {
      const asPr = prs.find((p) => p.repo.toLowerCase() === ref.repo.toLowerCase() && p.number === ref.number);
      if (asPr) {
        seat.prNumber = asPr.number;
        seat.prUrl = asPr.url;
        seat.issueTitle = asPr.title;
      } else seat.issueNumber = ref.number;
    }
    return seat;
  });
}

// ---------- escalations ----------

/** The short handle the manager types to answer one (the end of its user-task key). */
export function escalationRef(e: Pick<NanoEscalation, 'userTaskKey'>): string {
  return e.userTaskKey.slice(-5);
}

/** The deployed forms' choice fields (nano-workforce resources/forms/*.form), by the form they belong to. */
const FORMS: { match: RegExp; choice?: { key: string; values: string[] }; text: string }[] = [
  { match: /plan-review/, choice: { key: 'directive', values: ['proceed', 'revise'] }, text: 'notes' },
  { match: /empty-plan/, choice: { key: 'directive', values: ['accept', 'revise'] }, text: 'notes' },
  { match: /trial-merge/, choice: { key: 'action', values: ['proceed', 'rebase', 'abandon'] }, text: 'notes' },
  { match: /merge-approval/, choice: { key: 'mergeDecision', values: ['approve', 'revise'] }, text: 'answer' },
  { match: /feature-escalation/, choice: { key: 'resolution', values: ['answer', 'abandon'] }, text: 'answer' },
  { match: /readiness/, choice: { key: 'resolution', values: ['acknowledge', 'abandon'] }, text: 'answer' },
  { match: /delivery-human-generic/, choice: { key: 'decision', values: ['continue', 'retry'] }, text: 'note' },
  { match: /delivery-human-publish/, text: 'note' },
  { match: /feature-blocked|conformance|delivery-human/, text: 'note' },
  { match: /pr-escalation/, text: 'answer' },
];

function formFor(e: NanoEscalation) {
  const key = `${e.formKey ?? ''} ${e.kind}`;
  return FORMS.find((f) => f.match.test(key)) ?? null;
}

/** How one reads on the phone, with how to answer it. */
export function escalationMessage(e: NanoEscalation): string {
  const ref = escalationRef(e);
  const form = formFor(e);
  const how = form?.choice
    ? `Reply \`answer ${ref} <${form.choice.values.join('|')}> your note\``
    : `Reply \`answer ${ref} your answer\``;
  const subject = e.subjectUrl ? `[${e.subjectTitle || e.subjectKey}](${e.subjectUrl})` : e.subjectTitle || e.subjectKey;
  return [`🚨 **${e.kindLabel || e.kind}** needs you: ${subject}`, e.question?.trim() || '', how].filter(Boolean).join('\n\n');
}

export type Answer = { escalation: NanoEscalation; variables: Record<string, unknown> };

/**
 * A phone text as an answer: `answer <ref> [choice] text`, `<ref>` being escalationRef's handle.
 * null: not an answer at all (an ordinary message). A string: it was meant as one, and this is what's wrong.
 */
export function parseAnswer(text: string, open: readonly NanoEscalation[]): Answer | string | null {
  const m = /^\s*answer\s+(\S+)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const e = open.find((x) => escalationRef(x) === m[1] || x.userTaskKey === m[1]);
  if (!e) return `No open escalation ${m[1]}. Open ones: ${open.map(escalationRef).join(', ') || 'none'}.`;
  let rest = m[2].trim();
  const form = formFor(e);
  const variables: Record<string, unknown> = {};
  if (form?.choice) {
    const word = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!form.choice.values.includes(word)) return `Start your answer to ${m[1]} with one of: ${form.choice.values.join(', ')}.`;
    variables[form.choice.key] = word;
    rest = rest.slice(word.length).trim();
  } else if (!rest) return `Say what to tell them: answer ${m[1]} <your answer>.`;
  if (form) variables[form.text] = rest;
  else Object.assign(variables, { answer: rest, note: rest, notes: rest });
  return { escalation: e, variables };
}

// ---------- terminal ----------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

/** Captured terminal bytes as plain lines (escapes and carriage-return redraws dropped). */
export function chunkLines(chunk: string): string[] {
  return chunk
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.split('\r').pop() ?? '')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}
