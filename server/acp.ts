// The pure part of the ACP runtime (acpRunner.ts): how the office reads an ACP agent's messages (Agent Client
// Protocol, JSON-RPC 2.0 over stdio, one message per line) and the shell command the CEO calls its office tools with.

import type { CeoHarness } from '../shared/types.ts';
import type { LogEntry } from './agentRunner.ts';

/** The CLI to start for a harness spoken to over ACP. */
export const ACP_COMMANDS: Record<Exclude<CeoHarness, 'claude'>, string> = { 'nano-coder': 'nano-coder', copilot: 'copilot' };

/** Its command line: ACP mode, and the model when one is set ('' = the harness's own default). */
export function acpArgs(model: string): string[] {
  return ['--acp', ...(model ? ['--model', model] : [])];
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** One line of the agent's stdout as a JSON-RPC message; null for anything else (a stray log line). */
export function parseRpc(line: string): RpcMessage | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const m = JSON.parse(t) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as RpcMessage) : null;
  } catch {
    return null;
  }
}

/**
 * The answer to the agent asking permission for a tool call: allow it, as the office's agents never stop to ask
 * (the CEO's instructions say what it may do). Prefers "always" so it isn't asked again.
 */
export function permissionOutcome(params: Record<string, unknown> | undefined) {
  const options = Array.isArray(params?.options) ? (params.options as { optionId?: string; kind?: string }[]) : [];
  const pick = options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once') ?? options[0];
  return pick?.optionId ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** The agentCapabilities an ACP agent answers `initialize` with (the fields the office reads). */
export interface AcpCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: { additionalDirectories?: boolean };
}

/**
 * The reference clones for `session/new` / `session/load`: only when the agent advertised
 * `sessionCapabilities.additionalDirectories` — an agent may treat its roots as a filesystem boundary, so without
 * them a session rooted at the CEO's own dir can't read the clones it's told to inspect.
 */
export function additionalDirectories(caps: AcpCapabilities | undefined, dirs: string[]): string[] {
  return dirs.length && caps?.sessionCapabilities?.additionalDirectories ? dirs : [];
}

/**
 * Bounds a request's promise: it fails with `message` after `ms` (the caller's catch kills the child). Long-running
 * `session/prompt` turns pass no timeout — only startup (initialize/session/new/load) is bounded, so an agent that
 * stays alive without answering can't hold a CEO session slot forever.
 */
export function withTimeout<T>(p: Promise<T>, ms: number | undefined, message: string): Promise<T> {
  if (ms === undefined) return p;
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        ok(v);
      },
      (e) => {
        clearTimeout(t);
        fail(e);
      },
    );
  });
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function toolInput(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  const o = raw as Record<string, unknown>;
  for (const k of ['command', 'path', 'file_path', 'pattern', 'url', 'query']) if (typeof o[k] === 'string') return o[k] as string;
  return JSON.stringify(raw);
}

function contentText(c: unknown): string {
  if (!c) return '';
  if (Array.isArray(c)) return c.map(contentText).join('');
  const o = c as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text;
  return o.content ? contentText(o.content) : '';
}

/** What a `session/update` means for the office: text of the reply, a step to log, the tool now running. */
export interface UpdateEffect {
  text?: string; // a fragment of the agent's reply
  log?: LogEntry[];
  tool?: string | null; // the tool started (a name) or finished (null)
}

/** Reads one `session/update` notification. `titles` remembers each tool call's title for its result line. */
export function readUpdate(update: Record<string, unknown> | undefined, titles: Map<string, string>): UpdateEffect {
  if (!update) return {};
  const id = String(update.toolCallId ?? '');
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { text: contentText(update.content) };
    case 'agent_thought_chunk': {
      const t = contentText(update.content).trim();
      return t ? { log: [{ kind: 'thinking', text: short(t, 400) }] } : {};
    }
    case 'tool_call': {
      const title = String(update.title ?? update.kind ?? 'tool');
      titles.set(id, title);
      const input = toolInput(update.rawInput);
      return { tool: title, log: [{ kind: 'tool', tool: title, text: short(`${title}${input ? ` ${input}` : ''}`, 300) }] };
    }
    case 'tool_call_update': {
      if (update.status !== 'completed' && update.status !== 'failed') return {};
      const out = (typeof update.rawOutput === 'string' ? update.rawOutput : contentText(update.content)).trim();
      const first = out.split(/\r?\n/)[0] ?? '';
      const lines = out ? out.split(/\r?\n/).length : 0;
      const text = `  ⎿ ${update.status === 'failed' ? 'failed: ' : ''}${short(first, 160)}${lines > 1 ? ` (+${lines - 1} lines)` : ''}`;
      return { tool: null, log: [{ kind: update.status === 'failed' ? 'error' : 'result', tool: titles.get(id), text }] };
    }
    default:
      return {};
  }
}

/**
 * `cubefarm-office.cjs <tool> <json> | -b <base64url-json> | -`: the CEO's office tools for harnesses without MCP.
 * Posts to the office at CUBEFARM_OFFICE_URL (`.../api/office/<token>`, set in the CEO's environment), prints the
 * answer, and exits 1 when the office refuses. The JSON is base64url (`-b`) — letters, digits, `-` and `_` only, so
 * it survives cmd.exe, PowerShell and POSIX shells with no quoting — or `-` reads it from stdin.
 */
export const OFFICE_COMMAND_SOURCE = String.raw`// cubefarm: the CEO's office tools as a shell command.
const args = process.argv.slice(2);
const tool = args[0];
const base = process.env.CUBEFARM_OFFICE_URL;
if (!tool || !base) {
  console.error(base ? 'Usage: cubefarm-office <tool> <-b base64url-json | - | \'<json>\'' : 'CUBEFARM_OFFICE_URL is not set: run this from the CEO session.');
  process.exit(2);
}
const read = () => new Promise((ok) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => ok(s)); });
(async () => {
  const a = args[1];
  const body = a === undefined || a === '{}' ? '{}' : a === '-b' ? Buffer.from(args[2] || '', 'base64url').toString('utf8') : a === '-' ? await read() : a;
  const res = await fetch(base + '/' + encodeURIComponent(tool), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const out = await res.json().catch(() => ({ error: 'The office sent no answer (' + res.status + ').' }));
  if (out.error) {
    console.error(out.error);
    process.exit(1);
  }
  console.log(out.text);
})().catch((err) => {
  console.error('The office could not be reached: ' + err.message);
  process.exit(1);
});
`;
