import { useEffect, useRef } from 'react';
import type { RepoView } from '../../../shared/types';
import { useStore } from '../store';
import { paintNanoBoard, useMinute } from '../world/NanoBoard';
import { Panel } from './Panel';

/** A nano board up close: the same drawing as on the wall, big enough to read, with what to text to act on it. */
export function NanoBoardView({ repo }: { repo: RepoView }) {
  const repos = useStore((s) => s.repos);
  const now = useMinute();
  const canvas = useRef<HTMLCanvasElement>(null);
  const b = repo.nanoBoard;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    paintNanoBoard(ctx, c.width, c.height, repo, repos, Date.now());
  }, [repo, repos, now]);
  return (
    <Panel title={b?.kind === 'fleet' ? '🏭 nano-workforce fleet' : `⚙️ ${repo.fullName}`} accent={repo.color} wide>
      <canvas ref={canvas} width={2560} height={b?.kind === 'fleet' ? 1100 : 1000} style={{ width: '100%', height: 'auto', borderRadius: 8, background: '#fbfcfe' }} />
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
    </Panel>
  );
}
