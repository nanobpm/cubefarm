import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { RepoView } from '../../../shared/types';
import { useStore } from '../store';
import { BOARD } from './layout';
import { useCanvasTexture, useInteractable } from './interact';
import { drawFleetBoard, drawProcessBoard } from './nanoDraw';
import { Box } from './Toon';
import { BOARD_TEX } from './whiteboard';

/** The minute, so "running 3h" and "waiting 12m" on the board move on without repainting every frame. */
export function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Paint a nano board (process diagram or fleet) on a canvas. */
export function paintNanoBoard(ctx: CanvasRenderingContext2D, w: number, h: number, repo: RepoView, repos: RepoView[], now: number) {
  const b = repo.nanoBoard;
  if (!b) return;
  if (b.kind === 'process') drawProcessBoard(ctx, w, h, b, now);
  else drawFleetBoard(ctx, w, h, b, now, (id) => repos.find((r) => r.id === id)?.floor ?? null);
}

/** Nano mode's whiteboard (in place of the kanban): the floor's process, live, or on the bench the whole fleet. */
export function NanoBoard({ repo }: { repo: RepoView }) {
  const repos = useStore((s) => s.repos);
  const now = useMinute();
  const signature = useMemo(() => JSON.stringify([repo.nanoBoard, repos.map((r) => [r.id, r.floor]), Math.floor(now / 60_000)]), [repo.nanoBoard, repos, now]);
  const tex = useCanvasTexture(BOARD_TEX.w, BOARD_TEX.h, (ctx) => paintNanoBoard(ctx, BOARD_TEX.w, BOARD_TEX.h, repo, repos, Date.now()), [signature]);
  const label = repo.nanoBoard?.kind === 'fleet' ? 'Open the fleet board' : 'Open the process board';
  const ref = useInteractable<THREE.Group>({ id: `board-${repo.id}`, label, action: { kind: 'kanban', repoId: repo.id } }, 7);
  const cy = BOARD.y + BOARD.h / 2;
  return (
    <group ref={ref} position={[0, 0, BOARD.z]}>
      <Box size={[BOARD.w + 0.24, BOARD.h + 0.24, 0.06]} position={[0, cy, 0.03]} color="#aab4c3" outline shadow={false} />
      <mesh position={[0, cy, 0.065]}>
        <planeGeometry args={[BOARD.w, BOARD.h]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}
