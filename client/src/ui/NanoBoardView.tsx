import { useEffect, useId, useRef } from 'react';
import type { NanoBoard, NanoShape, RepoView } from '../../../shared/types';
import { useStore } from '../store';
import { paintNanoBoard, useMinute } from '../world/NanoBoard';
import { Panel } from './Panel';

/** Every state the canvas shows for a shape, joined: an incident step can still be held by a worker, so no early return. */
function shapeState(s: NanoShape): string {
  const parts: string[] = [];
  if (s.incident) parts.push('incident');
  if (s.workers.length) parts.push(`worker: ${s.workers.join(', ')}`);
  switch (s.waiting) {
    case 'escalation':
      parts.push('waiting on you (escalation)');
      break;
    case 'human':
      parts.push('waiting on a person');
      break;
    case 'queued':
      parts.push('queued, no worker yet');
      break;
    case 'event':
      parts.push('waiting for an event or timer');
      break;
  }
  if (s.active) parts.push('active');
  if (s.done) parts.push(`done ×${s.done}`);
  return parts.length ? parts.join('; ') : 'not reached';
}

/**
 * The same state the canvas paints, as text a screen reader can read: a canvas alone has no accessible contents, so
 * this structured list is what conveys the live board (step names, who's on them, what's waiting).
 */
function NanoBoardSummary({ board, id }: { board: NanoBoard | undefined; id: string }) {
  if (!board) return <div id={id} className="sr-only" />;
  if (board.kind === 'process') {
    return (
      <div id={id} className="sr-only">
        <h3>
          {board.title} — {board.subtitle}
          {board.incident ? ' (incident)' : ''}
        </h3>
        <ul>
          {board.shapes.map((s) => (
            <li key={s.id}>
              {s.name}: {shapeState(s)}
            </li>
          ))}
        </ul>
        {board.escalations.length > 0 && (
          <ul aria-label="Escalations waiting on you">
            {board.escalations.map((e) => (
              <li key={e.ref}>
                {e.label} (answer {e.ref})
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div id={id} className="sr-only">
      <h3>nano-workforce fleet</h3>
      <ul aria-label="Agent job types">
        {board.types.map((t) => (
          <li key={t.type}>
            {t.type}: {t.held.length ? `held by ${t.held.map((h) => h.worker).join(', ')}` : 'none held'}
            {t.queued.length ? `, ${t.queued.length} queued` : ''}
          </li>
        ))}
      </ul>
      <ul aria-label="Processes running">
        {board.processes.map((p, i) => (
          <li key={p.floor ?? i}>
            {p.label}
            {p.incident ? ' (incident)' : ''}: {p.active.length ? p.active.join(', ') : 'idle'}
          </li>
        ))}
      </ul>
      <p>Idle: {board.idle.length ? board.idle.map((w) => w.name).join(', ') : 'none'}.</p>
      <p>Offline: {board.offline.length ? board.offline.join(', ') : 'none'}.</p>
      {board.escalations.length > 0 && (
        <ul aria-label="Escalations waiting on you">
          {board.escalations.map((e) => (
            <li key={e.ref}>
              {e.label} (answer {e.ref})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A nano board up close: the same drawing as on the wall, big enough to read, with what to text to act on it. */
export function NanoBoardView({ repo, embedded }: { repo: RepoView; embedded?: boolean }) {
  const repos = useStore((s) => s.repos);
  const now = useMinute();
  const canvas = useRef<HTMLCanvasElement>(null);
  const summaryId = useId();
  const b = repo.nanoBoard;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    paintNanoBoard(ctx, c.width, c.height, repo, repos, Date.now());
  }, [repo, repos, now]);
  const title = b?.kind === 'fleet' ? '🏭 nano-workforce fleet' : `⚙️ ${repo.fullName}`;
  const body = (
    <>
      <NanoBoardSummary board={b} id={summaryId} />
      <canvas
        ref={canvas}
        role="img"
        aria-label={b?.kind === 'fleet' ? 'nano-workforce fleet board' : `Process board for ${repo.fullName}`}
        aria-describedby={summaryId}
        width={2560}
        height={b?.kind === 'fleet' ? 1100 : 1000}
        style={{ width: '100%', height: 'auto', borderRadius: 8, background: '#fbfcfe' }}
      />
      <p className="muted small">
        {b?.kind === 'process' ? (
          <>
            Green: a worker is on it · red: waiting on you · amber: queued, no worker yet · blue: waiting for an event · ×n: times it ran. Answer escalations on the phone (
            <code>answer &lt;id&gt; …</code>).{' '}
          </>
        ) : (
          <>Every agent job type with who holds one and what's queued for it, the processes running, and who's waiting on the bench. </>
        )}
        {repo.url && (
          <a href={repo.url} target="_blank" rel="noreferrer">
            {b?.kind === 'process' && repo.url.includes('/pull/') ? 'The PR ↗' : 'nano-workforce ↗'}
          </a>
        )}
      </p>
    </>
  );
  if (embedded) {
    return (
      <section className="kanban-embedded" style={{ ['--accent' as string]: repo.color }}>
        <h2 className="kanban-embedded-title">{title}</h2>
        {body}
      </section>
    );
  }
  return (
    <Panel title={title} accent={repo.color} wide>
      {body}
    </Panel>
  );
}
