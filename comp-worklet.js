
/* ===== DSP core: shared by the AudioWorklet (live) and the offline preview ===== */
class CompCore {
  constructor(fs) {
    this.fs = fs;
    this.p = { input: 0, threshold: -18, ratio: 4, knee: 6, attack: 10, release: 120, makeup: 4,
               detector: 'peak', rms: 10, topology: 'ff', lookahead: 0, mix: 1, bypass: false, element: 'vca' };
    this.ms = 0; this.gs = 0; this.fbL = 0; this.fbR = 0;
    this.gF = 0; this.gS = 0; this.mem = 0;
    this.dxL = 0; this.dyL = 0; this.dxR = 0; this.dyR = 0;
    this.size = Math.ceil(fs * 0.012) + 2;
    this.dL = new Float32Array(this.size); this.dR = new Float32Array(this.size); this.w = 0;
    this.set({});
  }
  set(o) {
    Object.assign(this.p, o);
    const p = this.p, fs = this.fs;
    const tc = (ms) => Math.exp(-1 / (Math.max(ms, 0.001) * 0.001 * fs));
    this.aA = tc(p.attack); this.aR = tc(p.release); this.aM = tc(p.rms);
    this.oFA = tc(10); this.oFR = tc(60); this.oSA = tc(30); this.oMU = tc(1500); this.oMD = tc(4000);
    this.dcR = Math.exp(-2 * Math.PI * 8 / fs);
    this.la = Math.min(this.size - 1, Math.round(p.lookahead * 0.001 * fs));
    this.gIn = Math.pow(10, p.input / 20); this.gMk = Math.pow(10, p.makeup / 20);
  }
  /* static characteristic: output dB for input dB */
  static curve(x, T, R, W, el) {
    if (el === 'varimu') {                       // ratio rises with level, knee is built in
      const over = x - T + 6;
      return over <= 0 ? x : x - (1 - 1 / R) * over * over / (over + 12);
    }
    const d = x - T;
    if (2 * d < -W) return x;
    if (W > 0 && 2 * Math.abs(d) <= W) return x + (1 / R - 1) * (d + W / 2) * (d + W / 2) / (2 * W);
    return T + d / R;
  }
  run(iL, iR, oL, oR, n, m) {
    const p = this.p, T = p.threshold, R = p.ratio, W = p.knee, el = p.element, fs = this.fs;
    const rms = p.detector === 'rms', fb = p.topology === 'fb', mix = p.mix, byp = p.bypass;
    const opto = el === 'opto', colour = el === 'fet' || el === 'varimu';
    let inPk = 0, outPk = 0, grMax = 0, lvlMax = -150;
    for (let i = 0; i < n; i++) {
      const xl = iL[i] * this.gIn, xr = iR[i] * this.gIn;
      const sl = fb ? this.fbL : xl, sr = fb ? this.fbR : xr;
      let lvl;
      if (rms) { const e = Math.max(sl * sl, sr * sr); this.ms = this.aM * this.ms + (1 - this.aM) * e; lvl = Math.sqrt(this.ms); }
      else lvl = Math.max(Math.abs(sl), Math.abs(sr));
      const xdB = lvl > 1e-7 ? 20 * Math.log10(lvl) : -140;
      const gc = xdB - CompCore.curve(xdB, T, R, W, el);
      if (opto) {
        /* EL panel + CdS cell: fast half (10/60 ms) + slow half whose release grows with "memory" */
        const aF = gc > this.gF ? this.oFA : this.oFR;
        this.gF = aF * this.gF + (1 - aF) * gc;
        const aS = gc > this.gS ? this.oSA : Math.exp(-1 / ((0.5 + 4.5 * this.mem) * fs));
        this.gS = aS * this.gS + (1 - aS) * gc;
        const tgt = Math.min(1, gc / 12), aMm = tgt > this.mem ? this.oMU : this.oMD;
        this.mem = aMm * this.mem + (1 - aMm) * tgt;
        this.gs = 0.5 * this.gF + 0.5 * this.gS;
      } else {
        const a = gc > this.gs ? this.aA : this.aR;
        this.gs = a * this.gs + (1 - a) * gc;
      }
      this.dL[this.w] = xl; this.dR[this.w] = xr;
      let r = this.w - this.la; if (r < 0) r += this.size;
      const dl = this.dL[r], dr = this.dR[r];
      if (++this.w >= this.size) this.w = 0;
      const g = Math.pow(10, -this.gs / 20);
      let wl = dl * g, wr = dr * g;
      if (colour) {
        /* FET: distortion grows with GR / Vari-Mu: steady even-order tube colour */
        const gn = Math.min(this.gs, 20) / 20;
        const dv = el === 'fet' ? 0.5 + 1.5 * gn : 0.8 + 0.4 * gn;
        const a2 = el === 'fet' ? 0.05 + 0.2 * gn : 0.15 + 0.1 * gn;
        const ul = Math.tanh(dv * (wl + a2 * wl * wl)) / dv, ur = Math.tanh(dv * (wr + a2 * wr * wr)) / dv;
        const yl = ul - this.dxL + this.dcR * this.dyL, yr = ur - this.dxR + this.dcR * this.dyR;
        this.dxL = ul; this.dyL = yl; this.dxR = ur; this.dyR = yr;
        wl = yl; wr = yr;
      }
      this.fbL = wl; this.fbR = wr;
      let yl, yr;
      if (byp) { yl = dl; yr = dr; }
      else { const k = mix * this.gMk; yl = wl * k + dl * (1 - mix); yr = wr * k + dr * (1 - mix); }
      oL[i] = yl; oR[i] = yr;
      const ai = Math.max(Math.abs(xl), Math.abs(xr)); if (ai > inPk) inPk = ai;
      const ao = Math.max(Math.abs(yl), Math.abs(yr)); if (ao > outPk) outPk = ao;
      if (this.gs > grMax) grMax = this.gs;
      if (xdB > lvlMax) lvlMax = xdB;
    }
    m[0] = inPk; m[1] = outPk; m[2] = grMax; m[3] = lvlMax; m[4] = this.mem;
  }
}


class CompLabProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.c = new CompCore(sampleRate);
    this.m = new Float32Array(5);
    this.out = new Float32Array(20);
    this.k = 0;
    this.scratch = new Float32Array(128);
    this.port.onmessage = (e) => this.c.set(e.data);
  }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || i.length === 0 || !o || o.length === 0) return true;
    const n = o[0].length;
    if (this.scratch.length < n) this.scratch = new Float32Array(n);
    this.c.run(i[0], i[1] || i[0], o[0], o[1] || this.scratch, n, this.m);
    this.out.set(this.m, this.k * 5);
    if (++this.k === 4) { this.port.postMessage(this.out.slice(0)); this.k = 0; }
    return true;
  }
}
registerProcessor('comp-lab', CompLabProcessor);
