/**
 * Nano mode's whiteboards (server/nano/floors.ts): a process floor's live BPMN diagram, and the bench's fleet board.
 * Plain canvas drawing, used for the 3D board's texture and the 2D view alike.
 */
import type { NanoBoard, NanoShape } from '../../../shared/types';
import { roundRect, wrap } from './draw';

type ProcessBoard = Extract<NanoBoard, { kind: 'process' }>;
type FleetBoard = Extract<NanoBoard, { kind: 'fleet' }>;

const INK = '#1d2433';
const MUTED = '#6b7385';
const LINE = '#c4cad6';
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** How a step looks: where the process is (green: a worker on it), waiting on people (red / orange), queued (amber). */
export function shapeLook(s: NanoShape): { fill: string; stroke: string; text: string } {
  if (s.incident) return { fill: '#ffe1e1', stroke: '#d62828', text: INK };
  if (s.active) {
    if (s.waiting === 'escalation') return { fill: '#ffd6d6', stroke: '#e63946', text: INK };
    if (s.waiting === 'human') return { fill: '#ffe6c7', stroke: '#f77f00', text: INK };
    if (s.waiting === 'queued') return { fill: '#fff1b8', stroke: '#e9b200', text: INK };
    if (s.waiting === 'event') return { fill: '#dcecff', stroke: '#3a86ff', text: INK };
    return { fill: '#c9f2e7', stroke: '#14967f', text: INK };
  }
  if (s.done) return { fill: '#eef1f6', stroke: '#8a94a8', text: '#3b4356' };
  return { fill: '#ffffff', stroke: LINE, text: '#9aa1b0' };
}

/** "4m", "3h", "2d" since `t`. */
export function ago(t: number | null, now: number): string {
  if (!t) return '';
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function header(ctx: CanvasRenderingContext2D, w: number, title: string, subtitle: string, right: string, alarm: boolean) {
  ctx.fillStyle = alarm ? '#d62828' : INK;
  ctx.font = `700 42px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const t = wrap(ctx, title, w * 0.7, 1)[0] ?? '';
  ctx.fillText(t, 36, 22);
  ctx.font = `400 28px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(wrap(ctx, subtitle, w * 0.7, 1)[0] ?? '', 36, 72);
  ctx.textAlign = 'right';
  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = alarm ? '#d62828' : MUTED;
  ctx.fillText(right, w - 36, 30);
  ctx.textAlign = 'left';
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg = '#fff', size = 22): number {
  ctx.font = `600 ${size}px ${FONT}`;
  const tw = ctx.measureText(text).width;
  roundRect(ctx, x, y, tw + size, size * 1.45, size * 0.7);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + size / 2, y + size * 0.74);
  ctx.textBaseline = 'top';
  return tw + size;
}

function arrow(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, width: number, dashed: boolean) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashed ? [width * 3, width * 3] : []);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.setLineDash([]);
  const [x1, y1] = pts[pts.length - 1];
  const [x0, y0] = pts[pts.length - 2];
  const a = Math.atan2(y1 - y0, x1 - x0);
  const s = width * 3.5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - s * Math.cos(a - 0.45), y1 - s * Math.sin(a - 0.45));
  ctx.lineTo(x1 - s * Math.cos(a + 0.45), y1 - s * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

/** A process floor's board: the diagram fitted to the board, with tokens, loop counts, workers and what waits. */
export function drawProcessBoard(ctx: CanvasRenderingContext2D, w: number, h: number, b: ProcessBoard, now: number) {
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, w, h);
  const busy = b.shapes.filter((s) => s.active).length;
  header(ctx, w, b.title, b.subtitle, b.incident ? '⚠️ INCIDENT' : `running ${ago(b.startedAt, now)} · ${busy} active`, b.incident);

  const escH = b.escalations.length ? 58 : 0;
  const top = 116;
  const area = { x: 50, y: top + 14, w: w - 100, h: h - top - 40 - escH };
  // Fill the board: the wall is wide and short, the diagrams less so, and BPMN's grid survives being squashed.
  const kx = Math.min(area.w / Math.max(1, b.bounds.w), 2.2);
  const ky = Math.min(area.h / Math.max(1, b.bounds.h), kx);
  const ox = area.x + (area.w - b.bounds.w * kx) / 2 - b.bounds.x * kx;
  const oy = area.y + (area.h - b.bounds.h * ky) / 2 - b.bounds.y * ky;
  const X = (x: number) => ox + x * kx;
  const Y = (y: number) => oy + y * ky;
  const lw = Math.max(2, 2.4 * kx);

  for (const e of b.edges) {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < e.points.length; i += 2) pts.push([X(e.points[i]), Y(e.points[i + 1])]);
    if (pts.length >= 2) arrow(ctx, pts, e.taken ? '#5c667a' : '#dde1e8', e.taken ? lw * 1.3 : lw, !e.taken);
  }

  // big enough to read across the room: labels may spill out of their boxes, on a white halo
  const font = Math.max(18, Math.min(28, 15 * kx));
  const label = (lines: string[], cx: number, cy: number, color: string, weight: number, size: number) => {
    ctx.font = `${weight} ${Math.round(size)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    lines.forEach((l, i) => {
      const y = cy + (i - (lines.length - 1) / 2) * size * 1.1;
      ctx.strokeStyle = 'rgba(251,252,254,0.92)';
      ctx.lineWidth = size * 0.3;
      ctx.strokeText(l, cx, y);
      ctx.fillStyle = color;
      ctx.fillText(l, cx, y);
    });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  };
  const order = [...b.shapes].sort((a, c) => Number(!!a.active || a.incident) - Number(!!c.active || c.incident)); // live ones on top
  for (const s of order) {
    const look = shapeLook(s);
    const x = X(s.x);
    const y = Y(s.y);
    const sw = s.w * kx;
    const sh = s.h * ky;
    const visited = s.active > 0 || s.done > 0 || s.incident;
    const thick = s.active || s.incident ? lw * 2.2 : lw;
    ctx.lineWidth = thick;
    ctx.strokeStyle = look.stroke;
    ctx.fillStyle = look.fill;
    const event = /Event$/.test(s.kind);
    const gateway = /Gateway$/.test(s.kind);
    if (event) {
      const r = Math.min(sw, sh) / 2;
      ctx.beginPath();
      ctx.arc(x + sw / 2, y + sh / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (/end/i.test(s.kind)) {
        ctx.lineWidth = thick * 2;
        ctx.stroke();
      }
    } else if (gateway) {
      ctx.beginPath();
      ctx.moveTo(x + sw / 2, y);
      ctx.lineTo(x + sw, y + sh / 2);
      ctx.lineTo(x + sw / 2, y + sh);
      ctx.lineTo(x, y + sh / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      roundRect(ctx, x, y, sw, sh, Math.min(12, sh / 4));
      ctx.fill();
      ctx.stroke();
      if (s.agent && sh > 26) {
        ctx.font = `${Math.round(Math.min(font * 0.8, sh * 0.4))}px ${FONT}`;
        ctx.textBaseline = 'top';
        ctx.fillText('🤖', x + 4, y + 3);
      }
    }
    // names: every task that ran or could take a worker; events and gateways only while a token sits there
    const named = s.name && s.name !== s.id;
    if (named && !event && !gateway && (visited || s.agent)) {
      const size = s.active ? font * 1.1 : font;
      ctx.font = `${s.active ? 700 : 500} ${Math.round(size)}px ${FONT}`;
      label(wrap(ctx, s.name, Math.max(sw - 8, 150), 2), x + sw / 2, y + sh / 2, visited ? look.text : '#9aa1b0', s.active ? 700 : 500, size);
    } else if (named && s.active) {
      ctx.font = `600 ${Math.round(font * 0.9)}px ${FONT}`;
      label(wrap(ctx, s.name, 220, 2), x + sw / 2, y + sh + font, INK, 600, font * 0.9);
    }
    // how many times it ran (loops), the tokens on it, who's on it, and for how long
    const cs = Math.round(Math.max(18, font * 0.85));
    if (s.done > 1 && !event) chip(ctx, x + sw - cs * 1.2, y - cs * 1.0, `×${s.done}`, '#5c667a', '#fff', cs);
    if (s.incident) chip(ctx, x - cs * 0.5, y - cs * 1.0, '⚠', '#d62828', '#fff', cs);
    else if (s.active) chip(ctx, x - cs * 0.5, y - cs * 1.0, s.active > 1 ? `● ${s.active}` : '●', look.stroke, '#fff', cs);
    const below: [string, string][] = s.workers.map((n) => [`👷 ${n}`, '#14967f']);
    if (s.active && s.waiting === 'queued') below.push(['🕒 no worker yet', '#b58a00']);
    if (s.active && s.waiting === 'escalation') below.push(['🚨 needs you', '#e63946']);
    if (s.active && s.since) below.push([ago(s.since, now), '#8a94a8']);
    if (!event && !gateway && below.length) {
      let cx = x;
      for (const [t, bg] of below) cx += chip(ctx, cx, y + sh + 5, t, bg, '#fff', cs) + 6;
    }
  }

  if (escH) {
    const y = h - escH - 10;
    roundRect(ctx, 30, y, w - 60, escH, 14);
    ctx.fillStyle = '#ffe1e1';
    ctx.fill();
    ctx.fillStyle = '#b5121b';
    ctx.font = `600 28px ${FONT}`;
    ctx.textBaseline = 'middle';
    const text = b.escalations.map((e) => `🚨 answer ${e.ref}: ${e.label}`).join('   ·   ');
    ctx.fillText(wrap(ctx, text, w - 100, 1)[0] ?? '', 48, y + escH / 2);
    ctx.textBaseline = 'top';
  }
}

/** The bench's board: every agent job type (held / queued), idle workers, escalations, and the processes running. */
export function drawFleetBoard(ctx: CanvasRenderingContext2D, w: number, h: number, b: FleetBoard, now: number, floorOf: (id: string | null) => number | null) {
  ctx.fillStyle = '#fbfcfe';
  ctx.fillRect(0, 0, w, h);
  const held = b.types.reduce((n, t) => n + t.held.length, 0);
  const queued = b.types.reduce((n, t) => n + t.queued.length, 0);
  header(
    ctx,
    w,
    'nano-workforce fleet',
    `${held} job(s) held · ${queued} queued · ${b.idle.length} idle · ${b.processes.length} process(es)${b.offline.length ? ` · ${b.offline.length} offline` : ''}`,
    b.escalations.length ? `🚨 ${b.escalations.length} need you` : '',
    queued > 0 && b.idle.length > 0,
  );
  const F = (id: string | null) => {
    const n = floorOf(id);
    return n ? `F${n}` : '';
  };
  const col = (x: number, title: string) => {
    ctx.fillStyle = MUTED;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(title.toUpperCase(), x, 130);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 166);
    ctx.lineTo(x + (title.length > 0 ? 300 : 0), 166);
    ctx.stroke();
  };
  const c1 = 36;
  const c2 = Math.round(w * 0.47);
  const c3 = Math.round(w * 0.74);
  // job types
  col(c1, 'Agent jobs');
  let y = 182;
  const rowH = 52;
  for (const t of b.types) {
    if (y + rowH > h - 10) break;
    ctx.font = `600 28px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.textBaseline = 'middle';
    ctx.fillText(wrap(ctx, t.type, 340, 1)[0] ?? '', c1, y + 18);
    let x = c1 + 360;
    for (const hd of t.held) {
      if (x > c2 - 160) break;
      x += chip(ctx, x, y, `👷 ${hd.worker}${F(hd.floor) ? ` ${F(hd.floor)}` : ''}${hd.since ? ` · ${ago(hd.since, now)}` : ''}`, '#14967f') + 8;
    }
    if (t.queued.length) {
      const oldest = Math.min(...t.queued.map((q) => q.since ?? now));
      x += chip(ctx, x, y, `🕒 ${t.queued.length} queued · ${ago(oldest, now)}`, b.idle.length ? '#e9b200' : '#8a94a8', INK) + 8;
    }
    ctx.textBaseline = 'top';
    y += rowH;
  }
  if (!b.types.length) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText('No agent jobs right now.', c1, y + 6);
  }
  // processes
  col(c2, 'Processes');
  y = 182;
  for (const p of b.processes) {
    if (y + 44 > h - 10) break;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillStyle = p.incident ? '#d62828' : INK;
    const line = `${F(p.floor)} ${p.incident ? '⚠️ ' : ''}${p.label.replace(/^⚠️ incident · /, '')}`;
    ctx.fillText(wrap(ctx, line, c3 - c2 - 30, 1)[0] ?? '', c2, y);
    ctx.font = `400 20px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(wrap(ctx, p.active.length ? `▶ ${p.active.join(', ')}` : '—', c3 - c2 - 30, 1)[0] ?? '', c2 + 46, y + 26);
    y += 52;
  }
  // bench + escalations
  col(c3, 'On the bench');
  y = 182;
  let x = c3;
  for (const i of b.idle) {
    ctx.font = `600 22px ${FONT}`;
    const wdt = ctx.measureText(`💤 ${i.name}`).width + 22;
    if (x + wdt > w - 30) {
      x = c3;
      y += 42;
    }
    x += chip(ctx, x, y, `💤 ${i.name}`, '#8a94a8') + 8;
  }
  for (const o of b.offline) {
    ctx.font = `600 22px ${FONT}`;
    const wdt = ctx.measureText(`🔌 ${o}`).width + 22;
    if (x + wdt > w - 30) {
      x = c3;
      y += 42;
    }
    x += chip(ctx, x, y, `🔌 ${o}`, '#c4cad6', INK) + 8;
  }
  if (!b.idle.length && !b.offline.length) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText('Everyone is working.', c3, y + 4);
  }
  y += 64;
  if (b.escalations.length && y < h - 60) {
    ctx.fillStyle = '#b5121b';
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText('NEED YOU', c3, y);
    y += 36;
    for (const e of b.escalations) {
      if (y + 30 > h - 10) break;
      ctx.font = `500 21px ${FONT}`;
      ctx.fillStyle = INK;
      ctx.fillText(wrap(ctx, `🚨 ${F(e.floor)} ${e.ref}: ${e.label}`, w - c3 - 36, 1)[0] ?? '', c3, y);
      y += 30;
    }
  }
}
