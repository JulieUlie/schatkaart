// Rear camera stream, cropping the on-screen card guide out of the video, torch, and a tiny
// thumbnail used to notice when a new card is held still (auto mode).

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.torchOn = false;
  }

  get on() { return !!this.stream; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const e = new Error('This browser does not give access to a camera.');
      e.code = 'unsupported';
      throw e;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    const v = this.video;
    v.muted = true;
    v.setAttribute('playsinline', '');
    v.srcObject = stream;
    await v.play().catch(() => {});
    if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    try {
      const caps = this.track.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch { /* not every camera allows it */ }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.torchOn = false;
    this.video.srcObject = null;
  }

  get torchSupported() {
    try { return !!this.track?.getCapabilities?.().torch; } catch { return false; }
  }

  async toggleTorch() {
    if (!this.track) return false;
    const next = !this.torchOn;
    await this.track.applyConstraints({ advanced: [{ torch: next }] });
    this.torchOn = next;
    return next;
  }

  // The <video> uses object-fit: cover, so map the guide's screen box back to video pixels.
  guideRect(guide) {
    const v = this.video;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh) return null;
    const vr = v.getBoundingClientRect();
    const gr = guide.getBoundingClientRect();
    const scale = Math.max(vr.width / vw, vr.height / vh);
    const offX = (vr.width - vw * scale) / 2;
    const offY = (vr.height - vh * scale) / 2;
    let sx = (gr.left - vr.left - offX) / scale;
    let sy = (gr.top - vr.top - offY) / scale;
    let sw = gr.width / scale;
    let sh = gr.height / scale;
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    sw = Math.min(sw, vw - sx);
    sh = Math.min(sh, vh - sy);
    return sw > 10 && sh > 10 ? { sx, sy, sw, sh } : null;
  }

  capture(guide, maxW = 1100) {
    const r = this.guideRect(guide);
    if (!r) return null;
    const w = Math.round(Math.min(maxW, r.sw));
    const h = Math.round((w * r.sh) / r.sw);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.video, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
    return c;
  }

  thumb(guide) {
    const r = this.guideRect(guide);
    if (!r) return null;
    if (!this._tc) {
      this._tc = document.createElement('canvas');
      this._tc.width = 24;
      this._tc.height = 33;
      this._tg = this._tc.getContext('2d', { willReadFrequently: true });
    }
    this._tg.drawImage(this.video, r.sx, r.sy, r.sw, r.sh, 0, 0, 24, 33);
    const d = this._tg.getImageData(0, 0, 24, 33).data;
    const out = new Uint8Array(24 * 33);
    for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return out;
  }
}

export function thumbDiff(a, b) {
  if (!a || !b) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export function thumbSpread(a) {
  let mean = 0;
  for (const x of a) mean += x;
  mean /= a.length;
  let v = 0;
  for (const x of a) v += (x - mean) ** 2;
  return Math.sqrt(v / a.length);
}

/** Draw an uploaded photo into a canvas; when it is clearly not card-shaped, keep the card-shaped centre. */
export async function canvasFromFile(file, maxW = 1100, cropToCard = true) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(async () => {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
  const W = bmp.width;
  const H = bmp.height;
  const ratio = 88 / 63;
  let sx = 0; let sy = 0; let sw = W; let sh = H;
  const r = H / W;
  if (!cropToCard) { /* keep the whole photo */ } else if (r < ratio * 0.85) { sw = H / ratio; sx = (W - sw) / 2; }
  else if (r > ratio * 1.15) { sh = W * ratio; sy = (H - sh) / 2; }
  const w = Math.round(Math.min(maxW, sw));
  const h = Math.round((w * sh) / sw);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close?.();
  return c;
}
