/**
 * Pure mapping from nano-workforce's state onto the office: worker names, how its
 * escalations read on the manager's phone, and how a texted reply becomes a completed user task.
 */
import type { NanoEscalation, NanoWorker } from './client.ts';

/** owner/repo#123 (or an issue / PR URL) → its parts; null when it's neither. */
export function parseRef(ref: string | undefined | null): { repo: string; number: number } | null {
  if (!ref) return null;
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim()) ?? /github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/.exec(ref);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/**
 * A human name for a worker. Its identity is often just an address (127.0.0.1), so the instance id
 * (`<host>-<harness>-<hex>`, e.g. joshs-macbook-pro-copilot-31c33e5f) names it: "copilot 31c3".
 */
export function workerName(w: NanoWorker): string {
  const id = w.identity && !/^[\d.:]+$|^localhost$/i.test(w.identity) ? w.identity : w.instance;
  const last = id.split(/[/:@\s]+/).filter(Boolean).pop() ?? id;
  const m = /^(?:.*-)?([^-]+)-([0-9a-f]{6,})$/i.exec(last);
  return (m ? `${m[1]} ${m[2].slice(0, 4)}` : last).slice(0, 24);
}

// ---------- escalations ----------

/** The short handle the manager types to answer one (the end of its user-task key). */
export function escalationRef(e: Pick<NanoEscalation, 'userTaskKey'>): string {
  return e.userTaskKey.length <= 8 ? e.userTaskKey : e.userTaskKey.slice(-6);
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

/** A line for a worker's screen. */
export interface ScreenLine {
  kind: 'text' | 'tool' | 'error';
  text: string;
  tool?: string;
}

const NOISE = /^\[usage_update\]$|^⚙ \[tool: [\w-]+\]$/;

/**
 * nano-workforce transcripts are JSON lines (`{"nwfTranscriptEvent":1,"kind":"message"|"tool-call"|"tool-result",…}`)
 * with assistant text streamed as fragments, mixed with raw harness output. Turns chunks into screen lines; the
 * text of a message still being streamed stays in `pending` until a newline or the next event ends it.
 */
export class TranscriptReader {
  private pending = '';

  read(chunks: string[]): ScreenLine[] {
    const out: ScreenLine[] = [];
    const flush = () => {
      for (const t of chunkLines(this.pending)) out.push({ kind: 'text', text: t.trimStart() });
      this.pending = '';
    };
    for (const raw of chunks.join('').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let ev: { nwfTranscriptEvent?: number; kind?: string; role?: string; text?: string; name?: string; ok?: boolean; content?: string; args?: Record<string, unknown> } | null = null;
      if (line.startsWith('{"nwfTranscriptEvent"')) {
        try {
          ev = JSON.parse(line);
        } catch {
          ev = null;
        }
      }
      if (!ev) {
        if (NOISE.test(line)) continue;
        flush();
        for (const t of chunkLines(raw)) out.push({ kind: 'text', text: t });
        continue;
      }
      if (ev.kind === 'message') {
        if (ev.role && ev.role !== 'assistant') continue;
        this.pending += ev.text ?? '';
        const nl = this.pending.lastIndexOf('\n');
        if (nl >= 0) {
          const done = this.pending.slice(0, nl);
          this.pending = this.pending.slice(nl + 1);
          for (const t of chunkLines(done)) out.push({ kind: 'text', text: t.trimStart() });
        }
        continue;
      }
      flush();
      if (ev.kind === 'tool-call') {
        const name = ev.name ?? 'tool';
        // Some harnesses name the tool only ("bash"): its command or path says what it's doing.
        const arg = ev.args?.command ?? ev.args?.path ?? ev.args?.file_path ?? ev.args?.pattern;
        const text = !name.includes(' ') && typeof arg === 'string' ? `${name}: ${arg.split('\n')[0]}` : name;
        out.push({ kind: 'tool', text: text.slice(0, 200), tool: name.split(' ')[0] });
      }
      else if (ev.kind === 'tool-result' && ev.ok === false) out.push({ kind: 'error', text: `✗ ${String(ev.content ?? 'tool failed').slice(0, 200)}` });
    }
    return out;
  }

  /** The text of a message the worker is still writing, ended (its job finished, or it's been a while). */
  end(): ScreenLine[] {
    const lines = chunkLines(this.pending).map((text) => ({ kind: 'text' as const, text: text.trimStart() }));
    this.pending = '';
    return lines;
  }
}
