// Live card-edge detection ("AR" outline). Each frame, a small grayscale copy of the area around the
// on-screen guide is searched for the card's four borders: edge points are collected along scanlines,
// a robust line is fitted per side (RANSAC), and the four lines are intersected into a quadrilateral.
// The quad drives the glowing outline and a perspective warp that straightens the card before OCR.

const WORK_W = 180;   // width of the analysis image in pixels
const EXPAND = 0.22;  // search this far outside the guide on every side
const CARD = 88 / 63;

export class EdgeTracker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.g = this.canvas.getContext('2d', { willReadFrequently: true });
    this.quad = null;      // smoothed corners in video pixels [tl, tr, br, bl]
    this.seenAt = 0;
    this.stableSince = 0;
    this.misses = 0;
  }

  reset() { this.quad = null; this.stableSince = 0; this.misses = 0; }

  /** Analyse one frame. `roi` is the guide area in video pixels. Returns the current state. */
  update(video, roi, now = performance.now()) {
    const found = detectQuad(this, video, roi);
    if (!found) {
      if (++this.misses > 4) { this.quad = null; this.stableSince = 0; }
      return this.state(now);
    }
    this.misses = 0;
    const span = Math.hypot(found[1][0] - found[0][0], found[1][1] - found[0][1]) || 1;
    if (this.quad) {
      const move = Math.max(...found.map((p, i) => Math.hypot(p[0] - this.quad[i][0], p[1] - this.quad[i][1])));
      if (move / span > 0.12) {
        this.quad = found;           // jumped: a different card or a big move
        this.stableSince = now;
      } else {
        this.quad = this.quad.map((q, i) => [q[0] * 0.45 + found[i][0] * 0.55, q[1] * 0.45 + found[i][1] * 0.55]);
        if (move / span > 0.025) this.stableSince = now;
      }
    } else {
      this.quad = found;
      this.stableSince = now;
    }
    this.seenAt = now;
    return this.state(now);
  }

  state(now = performance.now()) {
    const fresh = this.quad && now - this.seenAt < 400;
    return {
      quad: fresh ? this.quad : null,
      stableMs: fresh ? now - this.stableSince : 0,
    };
  }
}

function detectQuad(t, video, roi) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !roi) return null;
  let rx = roi.sx - roi.sw * EXPAND;
  let ry = roi.sy - roi.sh * EXPAND;
  let rw = roi.sw * (1 + 2 * EXPAND);
  let rh = roi.sh * (1 + 2 * EXPAND);
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  rw = Math.min(rw, vw - rx);
  rh = Math.min(rh, vh - ry);
  const W = WORK_W;
  const H = Math.max(40, Math.round((W * rh) / rw));
  if (t.canvas.width !== W || t.canvas.height !== H) { t.canvas.width = W; t.canvas.height = H; }
  t.g.drawImage(video, rx, ry, rw, rh, 0, 0, W, H);
  const d = t.g.getImageData(0, 0, W, H).data;

  // Colour-aware edges: a silver or yellow border on a light table differs in colour more than in
  // brightness, so each channel is blurred (3x3) and kept separately.
  const n = W * H;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let r = 0; let g = 0; let b = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * W + x + dx) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2];
        }
      }
      const p = y * W + x;
      R[p] = r / 9; G[p] = g / 9; B[p] = b / 9;
    }
  }
  const img = { R, G, B, W, H };

  // Expected guide box in work coordinates.
  const gx0 = ((roi.sx - rx) / rw) * W;
  const gx1 = ((roi.sx + roi.sw - rx) / rw) * W;
  const gy0 = ((roi.sy - ry) / rh) * H;
  const gy1 = ((roi.sy + roi.sh - ry) / rh) * H;
  const gw = gx1 - gx0;
  const gh = gy1 - gy0;

  // Search from the outer edge of the analysis area to well inside the guide, so cards held
  // smaller (down to ~45% of the guide) or larger than the frame are still found.
  const cx = (gx0 + gx1) / 2;
  const cy = (gy0 + gy1) / 2;
  const lefts = side(img, 'v', +1, 2, Math.floor(cx - gw * 0.2), gy0 - gh * 0.08, gy1 + gh * 0.08);
  const rights = side(img, 'v', -1, W - 3, Math.ceil(cx + gw * 0.2), gy0 - gh * 0.08, gy1 + gh * 0.08);
  const tops = side(img, 'h', +1, 2, Math.floor(cy - gh * 0.2), gx0 - gw * 0.08, gx1 + gw * 0.08);
  const bottoms = side(img, 'h', -1, H - 3, Math.ceil(cy + gh * 0.2), gx0 - gw * 0.08, gx1 + gw * 0.08);
  if (!lefts.length || !rights.length || !tops.length || !bottoms.length) return null;

  // Score every combination of candidate lines as a card-shaped quadrilateral.
  const combos = [];
  for (const L of lefts) for (const Rt of rights) for (const T of tops) for (const Bm of bottoms) {
    const q = [cross(L, T), cross(Rt, T), cross(Rt, Bm), cross(L, Bm)];
    if (q.some((p) => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
    const [tl, tr, br, bl] = q;
    const wTop = dist(tl, tr);
    const wBot = dist(bl, br);
    const hL = dist(tl, bl);
    const hR = dist(tr, br);
    const ratio = (hL + hR) / (wTop + wBot);
    const ratioErr = Math.abs(ratio - CARD) / CARD;
    if (ratioErr > 0.26) continue; // tilted shots shorten the card a lot in perspective
    if (Math.min(wTop, wBot) / Math.max(wTop, wBot) < 0.72 || Math.min(hL, hR) / Math.max(hL, hR) < 0.72) continue;
    const area = polyArea(q);
    if (area < gw * gh * 0.18 || area > W * H * 0.99) continue;
    if (!convex(q)) continue;
    // A card edge stops at the card's corners; a tablecloth or table line keeps going past them.
    // Count only the evidence between the corners and penalise evidence beyond them.
    const along = (line, p1, p2) => {
      const a = line.orient === 'v' ? Math.min(p1[1], p2[1]) : Math.min(p1[0], p2[0]);
      const b = line.orient === 'v' ? Math.max(p1[1], p2[1]) : Math.max(p1[0], p2[0]);
      let inside = 0;
      let outside = 0;
      for (const l of line.at.keys()) { if (l >= a - 3 && l <= b + 3) inside++; else outside++; }
      return (inside - 1.2 * outside) / line.lines;
    };
    const support = along(L, tl, bl) + along(Rt, tr, br) + along(T, tl, tr) + along(Bm, bl, br);
    if (support <= 0.3) continue;
    // A card's printed border has one colour all the way round (yellow, silver, black...).
    // Sample just inside each side: a quad built from a binder edge on one side and the card on
    // another has mismatching colours and loses.
    const sameBorder = borderConsistency(img, q);
    const score = support * (1 - ratioErr * 1.2) * sameBorder ** 2 * (0.6 + 0.4 * Math.min(1, area / (gw * gh)));
    combos.push({ q, score, area, support, ratioErr, sameBorder });
  }
  // Outlines nest: binder > pocket/sleeve > card > the inner edge of the card's own border.
  // Start from the best-scoring outline, then step inward while a clearly smaller (55-84% of the
  // area), plausible card-shaped outline sits inside it: that is a card inside a pocket. The inner
  // edge of a card's printed border encloses 85-93% of the card, so it never triggers a step.
  let best = null;
  if (combos.length) {
    combos.sort((a, b) => b.score - a.score);
    const top = combos[0].score;
    best = combos[0];
    for (let step = 0; step < 2; step++) {
      const outer = best;
      const inner = combos.find((c) => c !== outer && c.score >= top * 0.35
        && c.sameBorder >= 0.6 && c.ratioErr <= outer.ratioErr + 0.08
        && c.area >= outer.area * 0.55 && c.area <= outer.area * 0.84
        && c.q.every((p) => insideQuad(outer.q, p, 2)));
      if (!inner) break;
      best = inner;
    }
  }
  if (t.debugOn) t.debugCombos = combos;
  if (t.debugOn) {
    const toV = (pts) => pts.map(([x, y]) => [rx + (x / W) * rw, ry + (y / H) * rh]);
    t.debug = {
      sides: { lefts, rights, tops, bottoms },
      toV,
      top: (t.debugCombos || []).slice().sort((a, b) => b.score - a.score).slice(0, 5).map((c) => ({ ...c, q: toV(c.q) })),
    };
  }
  if (!best) return null;
  return best.q.map(([x, y]) => [rx + (x / W) * rw, ry + (y / H) * rh]);
}

function borderConsistency({ R, G, B, W, H }, q) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const means = [];
  for (let s = 0; s < 4; s++) {
    const [ax, ay] = q[s];
    const [bx, by] = q[(s + 1) % 4];
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let i = 1; i <= 9; i++) {
      const t = 0.15 + (0.7 * i) / 10;
      let x = ax + (bx - ax) * t;
      let y = ay + (by - ay) * t;
      // step 2.5 px straight inwards: on the printed border, just past the edge blur
      // (any deeper lands on the name bar or artwork of modern cards)
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let nx = -(by - ay) / len;
      let ny = (bx - ax) / len;
      if (nx * (cx - x) + ny * (cy - y) < 0) { nx = -nx; ny = -ny; }
      x += nx * 2.5;
      y += ny * 2.5;
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 1 || yi < 1 || xi >= W - 1 || yi >= H - 1) continue;
      const p = yi * W + xi;
      r += R[p]; g += G[p]; b += B[p]; n++;
    }
    if (!n) return 0.5;
    means.push([r / n, g / n, b / n]);
  }
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const d = Math.abs(means[i][0] - means[j][0]) + Math.abs(means[i][1] - means[j][1]) + Math.abs(means[i][2] - means[j][2]);
      if (d > worst) worst = d;
    }
  }
  return 1 / (1 + worst / 90);
}

/**
 * Collect edge candidates along scanlines for one side and fit a line with RANSAC.
 * 'v' sides (left/right) scan rows and fit x = a*y + b; 'h' sides (top/bottom) scan columns, y = a*x + b.
 * `dir` +1 scans from the low edge inward, -1 from the high edge inward; [from, to] is the band searched.
 */
function side({ R, G, B, W, H }, orient, dir, from, to, lineStart, lineEnd) {
  const pts = [];
  let lines = 0;
  const step = 2;
  const lo = Math.max(1, Math.min(from, to));
  const hi = Math.min((orient === 'v' ? W : H) - 2, Math.max(from, to));
  const grad = (p, q) => Math.abs(R[p] - R[q]) + Math.abs(G[p] - G[q]) + Math.abs(B[p] - B[q]);
  for (let l = Math.max(2, Math.round(lineStart)); l <= Math.min((orient === 'v' ? H : W) - 3, Math.round(lineEnd)); l += step) {
    lines++;
    const grads = [];
    let max = 0;
    for (let k = lo; k <= hi; k++) {
      let g = 0;
      for (let o = -1; o <= 1; o++) {
        g += orient === 'v'
          ? grad((l + o) * W + k + 1, (l + o) * W + k - 1)
          : grad((k + 1) * W + l + o, (k - 1) * W + l + o);
      }
      grads.push([k, g]);
      if (g > max) max = g;
    }
    // Noise-adaptive threshold: a peak must stand well clear of this scanline's typical texture,
    // so camera noise on a plain table never turns into an edge.
    const sorted = grads.map((x) => x[1]).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] || 0;
    const thr = Math.max(60, median * 3.5 + 25, max * 0.12);
    if (max < thr) continue;
    const peaks = [];
    for (let i = 1; i < grads.length - 1; i++) {
      const g = grads[i][1];
      if (g >= thr && g >= grads[i - 1][1] && g >= grads[i + 1][1]) peaks.push(grads[i]);
    }
    peaks.sort((a, b) => b[1] - a[1]);
    for (const [k, g] of peaks.slice(0, 8)) {
      // outwardness: 1 at the outer edge of the band, 0 at the inner end
      const out = dir > 0 ? 1 - (k - lo) / Math.max(1, hi - lo) : (k - lo) / Math.max(1, hi - lo);
      pts.push({ l, k, out, g });
    }
  }
  if (lines < 6 || pts.length < 6) return [];

  // Edge strength counts, not just how often an edge shows up: a card's printed border against a
  // sleeve or table is much stronger than the faint outline of a binder pocket around it.
  const gs = pts.map((p) => p.g).sort((a, b) => a - b);
  const ref = gs[Math.floor(gs.length * 0.9)] || 1;
  for (const p of pts) p.w = Math.min(1.5, p.g / ref);

  // Up to eight distinct lines per side (busy tablecloths need a long shortlist) (RANSAC, removing each found line's points).
  const found = [];
  let rest = pts;
  // Fixed seed: the same frame always gives the same lines, so the outline doesn't flicker.
  let seed = 0x9e3779b9;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  for (let round = 0; round < 8 && rest.length >= 6; round++) {
    let best = null;
    for (let it = 0; it < 220; it++) {
      const p1 = rest[(rand() * rest.length) | 0];
      const p2 = rest[(rand() * rest.length) | 0];
      if (p1.l === p2.l) continue;
      const a = (p2.k - p1.k) / (p2.l - p1.l);
      if (Math.abs(a) > 0.36) continue; // more than ~20° tilt: not a card edge we expect
      const b = p1.k - a * p1.l;
      const seen = new Map();
      for (const p of rest) {
        if (Math.abs(a * p.l + b - p.k) <= 1.8 && (seen.get(p.l)?.w ?? -1) < p.w) seen.set(p.l, p);
      }
      let wSum = 0;
      let outSum = 0;
      for (const p of seen.values()) { wSum += p.w; outSum += p.out; }
      const score = wSum * (1 + 0.12 * (outSum / Math.max(1, seen.size)));
      if (!best || score > best.score) best = { a, b, score, support: wSum, count: seen.size };
    }
    if (!best || best.count < Math.max(5, lines * 0.15)) break; // "is it a line" counts occurrences; strength only ranks lines
    // least-squares refit on the inliers
    const inl = rest.filter((p) => Math.abs(best.a * p.l + best.b - p.k) <= 1.8);
    let sl = 0; let sk = 0; let sll = 0; let slk = 0;
    for (const p of inl) { sl += p.l; sk += p.k; sll += p.l * p.l; slk += p.l * p.k; }
    const m = inl.length;
    const den = m * sll - sl * sl;
    let { a, b } = best;
    if (m >= 4 && Math.abs(den) > 1e-6) { a = (m * slk - sl * sk) / den; b = (sk - a * sl) / m; }
    const at = new Map();
    for (const p of inl) if ((at.get(p.l) ?? -1) < p.w) at.set(p.l, p.w);
    found.push({ orient, a, b, support: best.support / lines, at, lines });
    rest = rest.filter((p) => Math.abs(best.a * p.l + best.b - p.k) > 3);
  }
  return found;
}

// v-line: x = a*y + b ; h-line: y = a*x + b
function cross(v, h) {
  const den = 1 - v.a * h.a;
  if (Math.abs(den) < 1e-6) return null;
  const x = (v.a * h.b + v.b) / den;
  return [x, h.a * x + h.b];
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function polyArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % q.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function insideQuad(q, [px, py], tol) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const z = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / len; // signed distance to the side
    if (Math.abs(z) <= tol) continue;
    const sg = Math.sign(z);
    if (!sign) sign = sg;
    else if (sg !== sign) return false;
  }
  return true;
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const s = Math.sign(z);
    if (!s) return false;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ---------- perspective warp ----------

function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Homography mapping each dst point to its src point. */
function homography(dst, src) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i];
    const [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

/** Cut the card out of the video frame along `quad` and straighten it into a 63:88 canvas. */
export function warpCard(video, quad, outW = 760) {
  const outH = Math.round(outW * CARD);
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const x1 = Math.min(video.videoWidth, Math.ceil(Math.max(...xs)) + 2);
  const y1 = Math.min(video.videoHeight, Math.ceil(Math.max(...ys)) + 2);
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 20 || bh < 20) return null;
  const sc = document.createElement('canvas');
  sc.width = bw;
  sc.height = bh;
  const sg = sc.getContext('2d', { willReadFrequently: true });
  sg.drawImage(video, x0, y0, bw, bh, 0, 0, bw, bh);
  const S = sg.getImageData(0, 0, bw, bh).data;

  const h = homography(
    [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]],
    quad.map(([x, y]) => [x - x0, y - y0]),
  );
  if (!h) return null;
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const og = out.getContext('2d');
  const img = og.createImageData(outW, outH);
  const D = img.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = h[6] * x + h[7] * y + 1;
      const u = (h[0] * x + h[1] * y + h[2]) / den;
      const v = (h[3] * x + h[4] * y + h[5]) / den;
      const o = (y * outW + x) * 4;
      const ix = u | 0;
      const iy = v | 0;
      if (ix < 0 || iy < 0 || ix >= bw - 1 || iy >= bh - 1) { D[o + 3] = 255; continue; }
      const fx = u - ix;
      const fy = v - iy;
      const i00 = (iy * bw + ix) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + bw * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = S[i00 + c] + (S[i10 + c] - S[i00 + c]) * fx;
        const bot = S[i01 + c] + (S[i11 + c] - S[i01 + c]) * fx;
        D[o + c] = top + (bot - top) * fy;
      }
      D[o + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}
