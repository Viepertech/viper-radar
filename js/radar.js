// Canvas plan-position indicator (PPI) radar scope.
// A contact is only "painted" when the rotating sweep passes its bearing, and each paint
// fades with an exponential phosphor decay, like a real CRT scope.
import { rangeBearing } from './geo.js';

const GREEN = '61,255,122';
const RED = '255,77,77';
const AMBER = '255,176,0';
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export class Radar {
  constructor(canvas, { sweepPeriodMs = 4000, persistenceMs = 3600 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.period = sweepPeriodMs;
    this.persistence = persistenceMs;
    this.rangeNm = 80;
    this.showLabels = true;
    this.centerLabel = '';
    this.selectedId = null;
    this.contacts = new Map(); // id -> { trail: [{x, y, t}], lastPaint, data, range, bearing }
    this.prevSweep = 0;
    this.sweep = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width;
    this.h = r.height;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
    this.R = Math.max(10, Math.min(this.w, this.h) / 2 - 30);
  }

  reset() {
    this.contacts.clear();
    this.selectedId = null;
  }

  toPx(x, y) {
    return [this.cx + (x / this.rangeNm) * this.R, this.cy - (y / this.rangeNm) * this.R];
  }

  /** Canvas angle (radians, clockwise from +x) for a compass bearing. */
  static angle(bearingDeg) {
    return ((bearingDeg - 90) * Math.PI) / 180;
  }

  /** Advance the sweep and paint every target it passed. targets: [{ id, x, y, data }] in local nm. */
  update(nowMs, targets) {
    const sweep = ((nowMs % this.period) / this.period) * 360;
    const prev = this.prevSweep;
    const crossed = (b) => (prev <= sweep ? b > prev && b <= sweep : b > prev || b <= sweep);
    const seen = new Set();

    for (const t of targets) {
      seen.add(t.id);
      let c = this.contacts.get(t.id);
      if (!c) {
        c = { trail: [], lastPaint: -Infinity };
        this.contacts.set(t.id, c);
      }
      const { range, bearing } = rangeBearing(t.x, t.y);
      Object.assign(c, { data: t.data, range, bearing, x: t.x, y: t.y });
      if (range <= this.rangeNm && crossed(bearing)) {
        c.trail.push({ x: t.x, y: t.y, t: nowMs });
        if (c.trail.length > 7) c.trail.shift();
        c.lastPaint = nowMs;
      }
    }
    // Contacts that dropped out of the data fade away, then are forgotten.
    for (const [id, c] of this.contacts) {
      if (!seen.has(id) && nowMs - c.lastPaint > this.persistence * 2) this.contacts.delete(id);
    }
    this.prevSweep = sweep;
    this.sweep = sweep;
  }

  /** Id of the painted contact nearest to a pixel position (within 16 px), or null. */
  pick(px, py, nowMs) {
    let best = null;
    let bestD = 16;
    for (const [id, c] of this.contacts) {
      const p = c.trail.at(-1);
      if (!p || nowMs - p.t > this.persistence * 2) continue;
      const [x, y] = this.toPx(p.x, p.y);
      const d = Math.hypot(x - px, y - py);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  draw(nowMs) {
    const { ctx, cx, cy, R } = this;
    ctx.clearRect(0, 0, this.w, this.h);

    // Scope face
    const face = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    face.addColorStop(0, '#07210f');
    face.addColorStop(1, '#020905');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    this.drawBezel();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    this.drawGrid();
    this.drawSweep();
    this.drawContacts(nowMs);
    ctx.restore();

    // Centre mark and site label
    ctx.strokeStyle = `rgba(${GREEN},0.8)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.font = FONT;
    ctx.fillStyle = `rgba(${GREEN},0.75)`;
    ctx.fillText(this.centerLabel, cx + 7, cy + 14);
  }

  drawBezel() {
    const { ctx, cx, cy, R } = this;
    ctx.strokeStyle = `rgba(${GREEN},0.45)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let b = 0; b < 360; b += 5) {
      const a = Radar.angle(b);
      const long = b % 30 === 0;
      const inner = R - (long ? 9 : b % 10 === 0 ? 6 : 3);
      ctx.strokeStyle = `rgba(${GREEN},${long ? 0.7 : 0.35})`;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
      if (long) {
        ctx.fillStyle = `rgba(${GREEN},0.7)`;
        ctx.fillText(String(b).padStart(3, '0'), cx + Math.cos(a) * (R + 15), cy + Math.sin(a) * (R + 15));
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  drawGrid() {
    const { ctx, cx, cy, R } = this;
    ctx.lineWidth = 1;
    ctx.font = FONT;
    for (let i = 1; i <= 4; i++) {
      const r = (R * i) / 4;
      ctx.strokeStyle = `rgba(${GREEN},${i === 4 ? 0 : 0.18})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(${GREEN},0.45)`;
      ctx.fillText(`${Math.round((this.rangeNm * i) / 4)}`, cx + 4, cy - r + 13);
    }
    ctx.strokeStyle = `rgba(${GREEN},0.12)`;
    ctx.beginPath();
    for (let b = 0; b < 180; b += 30) {
      const a = Radar.angle(b);
      ctx.moveTo(cx - Math.cos(a) * R, cy - Math.sin(a) * R);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
    ctx.stroke();
  }

  drawSweep() {
    const { ctx, cx, cy, R } = this;
    const tailDeg = 50;
    const start = Radar.angle(this.sweep - tailDeg);
    const end = Radar.angle(this.sweep);
    const grad = ctx.createConicGradient(start, cx, cy);
    grad.addColorStop(0, `rgba(${GREEN},0)`);
    grad.addColorStop(tailDeg / 360, `rgba(${GREEN},0.28)`);
    grad.addColorStop(tailDeg / 360 + 0.001, `rgba(${GREEN},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, start, end);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = `rgba(${GREEN},0.9)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(end) * R, cy + Math.sin(end) * R);
    ctx.stroke();
  }

  drawContacts(nowMs) {
    const { ctx } = this;
    ctx.font = FONT;
    const labels = [];
    for (const [id, c] of this.contacts) {
      const last = c.trail.at(-1);
      if (!last) continue;
      const d = c.data;
      const color = d.emergency ? RED : GREEN;
      const selected = id === this.selectedId;

      // History dots (older paints), then the newest blip
      c.trail.forEach((p, i) => {
        const fade = Math.exp(-(nowMs - p.t) / this.persistence);
        const isLast = i === c.trail.length - 1;
        if (fade < 0.02) return;
        const [x, y] = this.toPx(p.x, p.y);
        ctx.fillStyle = `rgba(${color},${isLast ? fade : fade * 0.45})`;
        ctx.beginPath();
        ctx.arc(x, y, isLast ? 3.4 : 1.6, 0, Math.PI * 2);
        ctx.fill();
        if (isLast) {
          ctx.shadowColor = `rgba(${color},${fade})`;
          ctx.shadowBlur = 8 * fade;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });

      const fade = Math.max(Math.exp(-(nowMs - last.t) / this.persistence), selected ? 0.55 : 0);
      if (fade < 0.06) continue;
      const [x, y] = this.toPx(last.x, last.y);

      // Velocity leader: where the aircraft will be in one minute
      if (d.kt && d.track != null) {
        const lenNm = d.kt / 60;
        const a = Radar.angle(d.track);
        const lenPx = (lenNm / this.rangeNm) * this.R;
        ctx.strokeStyle = `rgba(${color},${fade * 0.6})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * lenPx, y + Math.sin(a) * lenPx);
        ctx.stroke();
      }

      if (selected) {
        ctx.strokeStyle = `rgba(${AMBER},0.95)`;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - 8, y - 8, 16, 16);
      }

      labels.push({ id, x, y, fade, color, selected, d, priority: selected ? 3 : d.emergency ? 2 : fade });
    }
    this.drawLabels(labels);
  }

  /** Data blocks, brightest first; a label is skipped if it would overlap one already drawn. */
  drawLabels(labels) {
    const { ctx } = this;
    const placed = [];
    labels.sort((a, b) => b.priority - a.priority);
    for (const l of labels) {
      if (!this.showLabels && !l.selected) continue;
      const line1 = l.d.callsign ?? l.d.id;
      const line2 = `${l.d.alt} ${l.d.kt ?? '--'}${l.d.vsArrow}`;
      const box = { x: l.x + 8, y: l.y - 15, w: Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 4, h: 27 };
      const overlaps = placed.some((p) => box.x < p.x + p.w && p.x < box.x + box.w && box.y < p.y + p.h && p.y < box.y + box.h);
      if (overlaps && !l.selected) continue;
      placed.push(box);
      const tint = l.selected ? AMBER : l.color;
      ctx.fillStyle = `rgba(${tint},${l.selected ? 0.95 : l.fade * 0.9})`;
      ctx.fillText(line1, l.x + 9, l.y - 4);
      ctx.fillStyle = `rgba(${tint},${l.selected ? 0.8 : l.fade * 0.65})`;
      ctx.fillText(line2, l.x + 9, l.y + 8);
    }
  }
}
