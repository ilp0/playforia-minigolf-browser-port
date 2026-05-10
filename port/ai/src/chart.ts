// Tiny sparkline plot for the per-episode return trace. Pure Canvas2D, no
// external charting library - the data is small (a few hundred episodes)
// and we only need lines + an axis hint.
//
// Two series overlaid:
//   - Light dots: raw per-episode return (noisy)
//   - Bold line: rolling mean over the last `windowSize` episodes
// The y-axis auto-scales to fit the data; the zero line is drawn faintly
// so you can read whether mean reward is above or below the "no shaping"
// neutral level.

export interface ChartConfig {
  /** Window size for the rolling mean line. */
  windowSize?: number;
  /** Maximum points kept in history; older ones are dropped. */
  maxPoints?: number;
}

export class RewardChart {
  private canvas: HTMLCanvasElement;
  private values: number[] = [];
  private windowSize: number;
  private maxPoints: number;

  constructor(canvas: HTMLCanvasElement, config: ChartConfig = {}) {
    this.canvas = canvas;
    this.windowSize = config.windowSize ?? 25;
    this.maxPoints = config.maxPoints ?? 500;
  }

  /** Append one episode's return and redraw. */
  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.maxPoints) this.values.shift();
    this.draw();
  }

  /** Reset history (use on map change / agent reset). */
  reset(): void {
    this.values = [];
    this.draw();
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background.
    ctx.fillStyle = "#0e0e10";
    ctx.fillRect(0, 0, W, H);

    if (this.values.length < 2) {
      // Empty state.
      ctx.fillStyle = "#555";
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText("waiting for episodes…", 6, H / 2);
      return;
    }

    // Determine y-range with a small margin so points don't sit on the edges.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const margin = (hi - lo) * 0.1;
    lo -= margin;
    hi += margin;

    const xOf = (i: number) =>
      (i / Math.max(1, this.values.length - 1)) * (W - 4) + 2;
    const yOf = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);

    // Zero line if it falls inside the visible range.
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = "#333";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yOf(0));
      ctx.lineTo(W, yOf(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Raw per-episode dots.
    ctx.fillStyle = "rgba(140, 180, 255, 0.35)";
    for (let i = 0; i < this.values.length; i++) {
      ctx.beginPath();
      ctx.arc(xOf(i), yOf(this.values[i]), 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rolling mean line.
    ctx.strokeStyle = "#7fffaa";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let prevSet = false;
    for (let i = 0; i < this.values.length; i++) {
      const start = Math.max(0, i - this.windowSize + 1);
      let sum = 0;
      for (let j = start; j <= i; j++) sum += this.values[j];
      const mean = sum / (i - start + 1);
      const x = xOf(i);
      const y = yOf(mean);
      if (!prevSet) {
        ctx.moveTo(x, y);
        prevSet = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Y-axis labels (lo / hi).
    ctx.fillStyle = "#888";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(hi.toFixed(0), 4, 11);
    ctx.fillText(lo.toFixed(0), 4, H - 3);
  }
}
