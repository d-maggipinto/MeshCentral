/*
 * Copyright (c) 2026 CYVELION LTD. All rights reserved.
 * CY Protocol — browser viewer (CY-MUX client). Clean-room.
 *
 * Implements the viewer half of the improved CY protocol the agent (cy_session.c) now speaks:
 *  - probes WebCodecs for the BEST codec/profile it can decode and advertises them in CY_HELLO
 *    (so CY negotiates H.264 High / AV1 / VP9 where possible — NX is locked to constrained baseline);
 *  - configures the VideoDecoder from CY_CONFIG;
 *  - decodes the VIDEO channel ([subtype]+Annex-B) to a canvas;
 *  - reports RTT/loss/fps on a timer via CY_STATS so the agent's adaptive-bitrate controller (cy_abr)
 *    can react (NX only has a static session cap).
 *
 * Usage: const v = new CYViewer(canvas, sendBytes, { getStats }); v.onCyEnvelope(payload); // cmd-90 payloads
 *        sendBytes(uint8array) must wrap+send one CY-MUX fragment envelope to the agent.
 */
(function (root) {
    var CYMux = (typeof require !== 'undefined') ? require('./cy_mux.js') : root.CYMux;
    var CH = CYMux.CH;                       // channel ids
    var CTRL = { HELLO: 1, CONFIG: 2, KEYFRAME_REQ: 3, STATS: 4 };
    var VID = { KEY: 0, DELTA: 1 };

    // Candidate decoder codec strings, best first. The agent keys HELLO on "avc1.64"/"high"/"av01"/"vp09".
    var CANDIDATES = [
        { tag: 'av01',      codec: 'av01.0.08M.08' },   // AV1 main
        { tag: 'hev1',      codec: 'hev1.1.6.L93.B0' },  // HEVC
        { tag: 'vp09',      codec: 'vp09.00.10.08' },    // VP9
        { tag: 'avc1.64',   codec: 'avc1.640028' },      // H.264 High L4.0  <- better than NX
        { tag: 'avc1.42',   codec: 'avc1.42E01E' }       // H.264 constrained baseline (NX-equivalent floor)
    ];

    function CYViewer(canvas, sendBytes, opts) {
        opts = opts || {};
        this.canvas = canvas; this.ctx2d = canvas ? canvas.getContext('2d') : null;
        this.getStats = opts.getStats || null;      // optional: () => Promise({rttMs,lossFrac}) from RTCPeerConnection
        this.mux = new CYMux(function (frag) { sendBytes(CYViewer._wrap(frag)); }, this._onMsg.bind(this));
        this.decoder = null; this.decoded = 0; this.lastFpsT = 0; this.lastFpsN = 0; this.fps = 0;
        this.supported = [];
        // audio (ch4 speaker / ch5 mic) + cursor (ch3) state
        this.audioCtx = null; this.adec = null; this.audioPlayhead = 0; this._aTs = 0;
        this.muted = !!opts.muted;                 // start muted until a user gesture resumes the context
        this._micOn = false; this._aenc = null; this._micStream = null;
        this._cursorCanvas = null;
    }
    // wrap a mux fragment in the MeshCentral cmd-90 envelope ([u16 90][u16 total]+frag)
    CYViewer._wrap = function (frag) {
        var n = frag.length, b = new Uint8Array(4 + n);
        b[0] = 0; b[1] = 90; b[2] = ((4 + n) >> 8) & 255; b[3] = (4 + n) & 255; b.set(frag, 4); return b;
    };

    CYViewer.prototype.start = function () {
        var self = this;
        this._probe().then(function (list) {
            self.supported = list;
            var hello = JSON.stringify({ codecs: list.map(function (x) { return x.tag; }), audio: ['opus'], v: 1 });
            self._sendCtrl(CTRL.HELLO, hello);
        });
    };
    CYViewer.prototype._probe = function () {
        if (typeof VideoDecoder === 'undefined' || !VideoDecoder.isConfigSupported)
            return Promise.resolve([CANDIDATES[CANDIDATES.length - 1]]); // assume baseline H.264
        return Promise.all(CANDIDATES.map(function (c) {
            return VideoDecoder.isConfigSupported({ codec: c.codec }).then(function (r) { return r.supported ? c : null; }).catch(function () { return null; });
        })).then(function (rs) { return rs.filter(Boolean); });
    };
    CYViewer.prototype._sendCtrl = function (type, jsonStr) {
        var body = jsonStr || '', b = new Uint8Array(1 + body.length); b[0] = type;
        for (var i = 0; i < body.length; i++) b[i + 1] = body.charCodeAt(i) & 255;
        this.mux.send(CH.CONTROL, b);
    };
    CYViewer.prototype.requestKeyframe = function () { this._sendCtrl(CTRL.KEYFRAME_REQ, ''); };

    // feed a received CY envelope payload (the bytes after the cmd-90 header)
    CYViewer.prototype.onCyEnvelope = function (payload) { this.mux.recv(payload); };

    CYViewer.prototype._onMsg = function (ch, msg) {
        if (ch === CH.CONTROL) {
            if (msg.length < 1) return;
            if (msg[0] === CTRL.CONFIG) { try { this._config(JSON.parse(_str(msg, 1))); } catch (e) { } }
        } else if (ch === CH.VIDEO) {
            this._decode(msg);
        } else if (ch === CH.AUDIO_OUT) {
            this._onAudioOut(msg);     // one raw Opus packet (48k/2ch/20ms) -> WebAudio
        } else if (ch === CH.CURSOR) {
            this._onCursor(msg);       // cursor shape/pos -> CSS cursor
        }
    };
    CYViewer.prototype._config = function (cfg) {
        var self = this;
        this.codec = cfg.codec; this.profile = cfg.profile; this.w = cfg.w; this.h = cfg.h; // expose negotiation result
        // map negotiated codec+profile -> a concrete WebCodecs codec string
        var codecStr = 'avc1.42E01E';
        if (cfg.codec === 'av1') codecStr = 'av01.0.08M.08';
        else if (cfg.codec === 'vp9') codecStr = 'vp09.00.10.08';
        else if (cfg.codec === 'vp8') codecStr = 'vp8';
        else if (cfg.codec === 'h264') codecStr = (cfg.profile === 'high') ? 'avc1.640028' : 'avc1.42E01E';
        try {
            if (this.decoder) { try { this.decoder.close(); } catch (e) { } }
            this.decoder = new VideoDecoder({
                output: function (frame) { self._draw(frame); self.decoded++; frame.close(); },
                error: function (e) { self.requestKeyframe(); }
            });
            this.decoder.configure({ codec: codecStr, optimizeForLatency: true });
            if (!this._statsTimer) this._statsTimer = setInterval(this._reportStats.bind(this), 1000);
        } catch (e) { this.decoder = null; }
    };
    CYViewer.prototype._decode = function (msg) {
        if (!this.decoder || msg.length < 1) return;
        var isKey = (msg[0] === VID.KEY);
        try {
            this.decoder.decode(new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta', timestamp: (performance.now() * 1000) | 0, data: msg.subarray(1)
            }));
        } catch (e) { this.requestKeyframe(); }
    };
    CYViewer.prototype._draw = function (frame) {
        if (!this.ctx2d) return;
        if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
        if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
        try { this.ctx2d.drawImage(frame, 0, 0); } catch (e) { }
    };
    CYViewer.prototype._reportStats = function () {
        var self = this, now = performance.now();
        if (this.lastFpsT) this.fps = Math.round(this.decoded - this.lastFpsN) * 1000 / (now - this.lastFpsT);
        this.lastFpsT = now; this.lastFpsN = this.decoded;
        var emit = function (rtt, loss) {
            self._sendCtrl(CTRL.STATS, JSON.stringify({ fps: self.fps | 0, rtt: rtt | 0, loss: +(loss || 0).toFixed(3) }));
        };
        if (this.getStats) { this.getStats().then(function (s) { emit(s.rttMs, s.lossFrac); }).catch(function () { emit(0, 0); }); }
        else emit(0, 0); // reliable relay: loss≈0, rtt unknown; agent still adapts on fps
    };
    // ---------------- speaker audio (CH.AUDIO_OUT): Opus -> WebCodecs AudioDecoder -> AudioContext ----------------
    CYViewer.prototype._ensureAudio = function () {
        if (this.audioCtx) return;
        try {
            var AC = root.AudioContext || root.webkitAudioContext;
            this.audioCtx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
            this.audioPlayhead = 0;
            if (typeof AudioDecoder !== 'undefined') {
                var self = this;
                this.adec = new AudioDecoder({
                    output: function (data) { self._playAudioData(data); },
                    error: function () { try { self.adec && self.adec.close(); } catch (e) { } self.adec = null; }
                });
                this.adec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
            }
        } catch (e) { this.audioCtx = null; this.adec = null; }
    };
    CYViewer.prototype._onAudioOut = function (msg) {
        if (this.muted || !msg || msg.length < 2) return;
        this._ensureAudio();
        if (!this.adec) return;
        try {
            this._aTs += 20000; // 20 ms per Opus frame, monotonic microsecond timestamps
            this.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: this._aTs, duration: 20000, data: msg }));
        } catch (e) { }
    };
    CYViewer.prototype._playAudioData = function (data) {
        var ctx = this.audioCtx; if (!ctx) { try { data.close(); } catch (e) { } return; }
        if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { } }
        try {
            var ch = data.numberOfChannels, frames = data.numberOfFrames, rate = data.sampleRate || 48000;
            var buf = ctx.createBuffer(ch, frames, rate);
            for (var c = 0; c < ch; c++) {
                var tmp = new Float32Array(frames);
                data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
                buf.copyToChannel(tmp, c);
            }
            var src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
            var now = ctx.currentTime;
            if (this.audioPlayhead < now + 0.02) this.audioPlayhead = now + 0.06; // ~60 ms jitter buffer on (re)prime
            src.start(this.audioPlayhead);
            this.audioPlayhead += buf.duration;
        } catch (e) { }
        try { data.close(); } catch (e) { }
    };
    // Call from a user gesture (click) to satisfy autoplay policy and unmute.
    CYViewer.prototype.enableAudio = function () {
        this.muted = false; this._ensureAudio();
        if (this.audioCtx && this.audioCtx.state === 'suspended') { try { this.audioCtx.resume(); } catch (e) { } }
    };
    CYViewer.prototype.setMuted = function (m) { this.muted = !!m; };

    // ---------------- microphone (CH.AUDIO_IN): mic -> WebCodecs AudioEncoder(Opus) -> mux ----------------
    // Must be called from a user gesture. Returns Promise<boolean>.
    CYViewer.prototype.startMic = function () {
        var self = this;
        if (this._micOn) return Promise.resolve(true);
        if (typeof AudioEncoder === 'undefined' || typeof root.MediaStreamTrackProcessor === 'undefined'
            || !root.navigator || !navigator.mediaDevices) return Promise.resolve(false);
        return navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 2, sampleRate: 48000, echoCancellation: true, noiseSuppression: true }
        }).then(function (stream) {
            self._micStream = stream;
            self._aenc = new AudioEncoder({
                output: function (chunk) {
                    var b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
                    self.mux.send(CH.AUDIO_IN, b);     // one Opus packet inside cmd-90, as the agent expects
                },
                error: function () { }
            });
            self._aenc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000, opus: { frameDuration: 20000 } });
            var track = stream.getAudioTracks()[0];
            var reader = new root.MediaStreamTrackProcessor({ track: track }).readable.getReader();
            self._micOn = true;
            (function pump() {
                reader.read().then(function (r) {
                    if (r.done || !self._micOn) { if (r.value) { try { r.value.close(); } catch (e) { } } return; }
                    try { if (self._aenc && self._aenc.state === 'configured') self._aenc.encode(r.value); } catch (e) { }
                    try { r.value.close(); } catch (e) { }
                    pump();
                }).catch(function () { });
            })();
            return true;
        }).catch(function () { self.stopMic(); return false; });
    };
    CYViewer.prototype.stopMic = function () {
        this._micOn = false;
        try { if (this._micStream) this._micStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
        try { if (this._aenc && this._aenc.state !== 'closed') this._aenc.close(); } catch (e) { }
        this._aenc = null; this._micStream = null;
    };

    // ---------------- cursor (CH.CURSOR): [u8 type] type0=hide; type1 shape [u16 hotX,hotY,w,h][RGBA w*h] ----------------
    CYViewer.prototype._onCursor = function (msg) {
        if (!this.canvas || !msg || msg.length < 1 || typeof document === 'undefined') return;
        var t = msg[0];
        if (t === 0) { this.canvas.style.cursor = 'none'; return; }
        if (t !== 1 || msg.length < 9) return;
        var dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
        var hx = dv.getUint16(1), hy = dv.getUint16(3), w = dv.getUint16(5), h = dv.getUint16(7);
        if (!w || !h || w > 256 || h > 256 || msg.length < 9 + w * h * 4) return;
        var cc = this._cursorCanvas || (this._cursorCanvas = document.createElement('canvas'));
        cc.width = w; cc.height = h;
        var cctx = cc.getContext('2d');
        var img = cctx.createImageData(w, h); img.data.set(msg.subarray(9, 9 + w * h * 4));
        cctx.putImageData(img, 0, 0);
        try { this.canvas.style.cursor = 'url(' + cc.toDataURL('image/png') + ') ' + hx + ' ' + hy + ', auto'; } catch (e) { }
    };

    CYViewer.prototype.destroy = function () {
        this.stopMic();
        try { if (this.decoder) this.decoder.close(); } catch (e) { } this.decoder = null;
        try { if (this.adec) this.adec.close(); } catch (e) { } this.adec = null;
        try { if (this.audioCtx) this.audioCtx.close(); } catch (e) { } this.audioCtx = null;
        if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    };

    function _str(u8, off) { var s = ''; for (var i = off || 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }

    if (typeof module !== 'undefined' && module.exports) module.exports = CYViewer; else root.CYViewer = CYViewer;
})(typeof window !== 'undefined' ? window : this);
