/**
 * The office with nano-workforce behind it (`--nano <url>`): nano-workforce plans, implements, reviews and merges;
 * the office shows its workers at desks, their terminals, its escalations on the phone, and hands it issues.
 * Polls the app's REST API; the office (Swarm) applies what it hears through NanoHost.
 */
import type { NanoApi, NanoEscalation, NanoPr } from './client.ts';
import { escalationMessage, escalationRef, parseAnswer, seatsFor, TranscriptReader, type ScreenLine, type Seat } from './mirror.ts';

export interface NanoHost {
  /** The connected floors' repo ids (owner/name). */
  repoIds(): string[];
  /** Put this worker at a desk (hiring them the first time), or update what they're doing. */
  seat(seat: Seat): void;
  /** A worker that's gone from nano-workforce: their desk empties. */
  unseat(instance: string): void;
  /** Lines for a worker's screen. */
  log(instance: string, lines: ScreenLine[]): void;
  /** A message on the manager's phone. */
  phone(text: string): void;
  /** The manager should hear about this one (notifications). */
  needsHuman(title: string, body: string): void;
}

export interface NanoConfig {
  url: string;
  pollMs: number;
  /** Base branch for hand-offs: '' = the repo's default branch; may contain {n} (the issue number). */
  baseBranch: string;
}

const MAX_LINES_PER_TICK = 200;

export class NanoBridge {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private seated = new Set<string>();
  private offsets = new Map<string, number>();
  private readers = new Map<string, TranscriptReader>();
  private following = new Map<string, string>(); // worker instance → the stream it's on
  private told = new Set<string>(); // escalations already on the phone
  private open: NanoEscalation[] = [];
  private prs: NanoPr[] = [];
  private down: string | null = null;

  constructor(
    private api: NanoApi,
    private host: NanoHost,
    private cfg: NanoConfig,
  ) {}

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether the app answered on the last poll (null), or why not. */
  get error() {
    return this.down;
  }

  /** The PRs nano-workforce is driving right now. */
  activePrs(): readonly NanoPr[] {
    return this.prs;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [supply, prs, escalations] = await Promise.all([this.api.supply(), this.api.activePrs(), this.api.escalations()]);
      if (this.down) this.host.phone(`✅ nano-workforce is reachable again at ${this.cfg.url}.`);
      this.down = null;
      this.prs = prs;
      const seats = seatsFor(supply, prs, this.host.repoIds());
      for (const s of seats) {
        this.host.seat(s);
        this.seated.add(s.instance);
      }
      for (const gone of [...this.seated].filter((i) => !seats.some((s) => s.instance === i))) {
        this.host.unseat(gone);
        this.seated.delete(gone);
      }
      this.escalations(escalations);
      for (const s of seats) {
        const was = this.following.get(s.instance);
        if (was && was !== s.stream) this.endStream(s.instance, was);
        if (s.stream) this.following.set(s.instance, s.stream);
        else this.following.delete(s.instance);
      }
      await Promise.all(seats.filter((s) => s.stream).map((s) => this.follow(s.instance, s.stream as string)));
    } catch (err) {
      const msg = (err as Error).message;
      if (!this.down) this.host.phone(`⚠️ Can't reach nano-workforce at ${this.cfg.url}: ${msg}`);
      this.down = msg;
    } finally {
      this.ticking = false;
    }
  }

  private escalations(list: NanoEscalation[]) {
    this.open = list;
    for (const e of list) {
      if (this.told.has(e.userTaskKey)) continue;
      this.told.add(e.userTaskKey);
      this.host.phone(escalationMessage(e));
      this.host.needsHuman(`${e.kindLabel || e.kind} needs you`, `${e.subjectTitle || e.subjectKey} (answer ${escalationRef(e)})`);
    }
    for (const k of [...this.told]) if (!list.some((e) => e.userTaskKey === k)) this.told.delete(k);
  }

  /** New output on a worker's stream since the last poll. The first look starts near its end, not its beginning. */
  private async follow(instance: string, stream: string) {
    const from = this.offsets.get(stream) ?? 0;
    const t = await this.api.transcript(stream, from).catch(() => null);
    if (!t) return;
    this.offsets.set(stream, t.nextOffset);
    if (t.entries.length === 0) return;
    let reader = this.readers.get(stream);
    if (!reader) this.readers.set(stream, (reader = new TranscriptReader()));
    const lines = reader.read(t.entries.map((e) => e.chunk));
    if (lines.length) this.host.log(instance, lines.slice(-MAX_LINES_PER_TICK));
  }

  /** A worker moved off a stream (its job ended): what it was still saying, then forget the stream. */
  private endStream(instance: string, stream: string) {
    const rest = this.readers.get(stream)?.end() ?? [];
    if (rest.length) this.host.log(instance, rest);
    this.readers.delete(stream);
    this.offsets.delete(stream);
  }

  /** Hand an issue to the fleet: nano-workforce plans it and fans it out. */
  async handOff(repo: { fullName: string; defaultBranch: string }, issue: number) {
    const base = this.cfg.baseBranch ? this.cfg.baseBranch.replaceAll('{n}', String(issue)) : repo.defaultBranch;
    await this.api.startPlanFanout({ issue: `${repo.fullName}#${issue}`, baseBranch: base, ...(base === repo.defaultBranch ? { confirmDefaultBase: true } : {}) });
    setTimeout(() => void this.tick(), 1500).unref?.();
    return base;
  }

  /** A text from the manager: an answer to an escalation (the reply to send back), or null when it isn't one. */
  async answer(text: string): Promise<string | null> {
    if (/^\s*answer\b/i.test(text) && this.open.length === 0) await this.tick();
    const parsed = parseAnswer(text, this.open);
    if (parsed === null || typeof parsed === 'string') return parsed;
    await this.api.completeUserTask(parsed.escalation.userTaskKey, parsed.variables);
    this.open = this.open.filter((e) => e !== parsed.escalation);
    setTimeout(() => void this.tick(), 1500).unref?.();
    return `👍 Sent to nano-workforce: ${parsed.escalation.kindLabel || parsed.escalation.kind} on ${parsed.escalation.subjectTitle || parsed.escalation.subjectKey}.`;
  }

  /** What's waiting on the manager, for a plain "status" text. */
  summary(): string {
    if (this.down) return `nano-workforce is unreachable: ${this.down}`;
    const lines = [`🏭 nano-workforce: ${this.prs.length} PR(s) in flight, ${this.open.length} escalation(s) open.`];
    for (const e of this.open) lines.push(`• ${escalationRef(e)}: ${e.kindLabel || e.kind} on ${e.subjectTitle || e.subjectKey}`);
    for (const p of this.prs.slice(0, 10)) lines.push(`• ${p.repo}#${p.number} ${p.status} (round ${p.round})${p.title ? `: ${p.title}` : ''}`);
    return lines.join('\n');
  }
}
