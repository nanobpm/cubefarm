/**
 * The office with nano-workforce behind it (`--nano <url>`): nano-workforce's BPMN processes plan, implement, review
 * and merge. Each live process instance is a floor, its agent steps the desks, and remote workers walk to the step whose
 * job they hold (server/nano/floors.ts). Polls the app's REST API and the engine's; the office (Swarm) applies what it
 * hears through NanoHost.
 */
import type { EngineApi, EngineElement, NanoApi, NanoEscalation, NanoPr } from './client.ts';
import { buildWorld, parseProcess, type Floor, type ProcessModel, type Seat } from './floors.ts';
import { escalationMessage, escalationRef, parseAnswer, TranscriptReader, type ScreenLine } from './mirror.ts';

export interface NanoHost {
  /** The live process instances: floors open for new ones, close for finished ones, whiteboards refresh. */
  floors(floors: Floor[]): Promise<void>;
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
  /** Where the floors are kept for the office's backend (server/nano/backend.ts). */
  book?: { set(floors: Floor[]): void };
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
  private models = new Map<string, ProcessModel>();
  private names = new Map<string, string>(); // root instance key → floor id
  private floorList: Floor[] = [];

  constructor(
    private api: NanoApi,
    private engine: EngineApi,
    private host: NanoHost,
    private cfg: NanoConfig,
  ) {}

  /** The floors as last seen. */
  get floors(): readonly Floor[] {
    return this.floorList;
  }

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
      const [supply, prs, escalations, instances, jobs] = await Promise.all([
        this.api.supply(),
        this.api.activePrs(),
        this.api.escalations(),
        this.engine.activeInstances(),
        this.engine.activeJobs(),
      ]);
      if (this.down) this.host.phone(`✅ nano-workforce is reachable again at ${this.cfg.url}.`);
      this.down = null;
      this.prs = prs;
      await Promise.all(
        [...new Set(instances.map((i) => i.processDefinitionKey))]
          .filter((k) => !this.models.has(k))
          .map(async (k) => {
            const xml = await this.engine.processXml(k).catch(() => null);
            if (xml) this.models.set(k, parseProcess(xml));
          }),
      );
      const roots = instances.filter((i) => !i.parentProcessInstanceKey || !instances.some((x) => x.processInstanceKey === i.parentProcessInstanceKey));
      const elements = new Map<string, EngineElement[]>();
      await Promise.all(
        instances.map(async (i) => {
          const root = roots.find((r) => r.processInstanceKey === i.processInstanceKey)?.processInstanceKey ?? i.processInstanceKey;
          const els = await this.engine.activeElements(i.processInstanceKey).catch(() => []);
          elements.set(root, [...(elements.get(root) ?? []), ...els]);
        }),
      );
      const world = buildWorld({ supply, prs, escalations, instances, jobs, elements, models: this.models, names: this.names });
      this.floorList = world.floors;
      this.cfg.book?.set(world.floors);
      await this.host.floors(world.floors);
      const seats = world.seats;
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

  /** Hand an issue to the fleet: nano-workforce plans it and fans it out over its workers. */
  async handOff(issue: string, base?: string) {
    const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(issue);
    if (!m) throw new Error(`"${issue}" isn't an issue: use owner/repo#123`);
    const branch = base || (this.cfg.baseBranch ? this.cfg.baseBranch.replaceAll('{n}', m[2]) : 'main');
    await this.api.startPlanFanout({ issue, baseBranch: branch, ...(base || this.cfg.baseBranch ? {} : { confirmDefaultBase: true }) });
    setTimeout(() => void this.tick(), 1500).unref?.();
    return branch;
  }

  /** A text from the manager: an answer to an escalation (the reply to send back), or null when it isn't one. */
  async answer(text: string): Promise<string | null> {
    const start = /^\s*start\s+(\S+)(?:\s+(?:on\s+)?(\S+))?\s*$/i.exec(text);
    if (start) {
      const base = await this.handOff(start[1], start[2]);
      return `🚀 ${start[1]} handed to nano-workforce (base ${base}): its planner fans it out, and a new floor opens when the process starts.`;
    }
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
    const lines = [`🏭 nano-workforce: ${this.floorList.length} process(es) running, ${this.prs.length} PR(s) in flight, ${this.open.length} escalation(s) open.`];
    for (const f of this.floorList) lines.push(`• ${f.id}${f.incident ? ' ⚠️ incident' : ''}: ${f.description}`);
    for (const e of this.open) lines.push(`• ${escalationRef(e)}: ${e.kindLabel || e.kind} on ${e.subjectTitle || e.subjectKey}`);
    for (const p of this.prs.slice(0, 10)) lines.push(`• ${p.repo}#${p.number} ${p.status} (round ${p.round})${p.title ? `: ${p.title}` : ''}`);
    return lines.join('\n');
  }
}
