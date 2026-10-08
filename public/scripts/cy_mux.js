/*
 * Copyright (c) 2026 CYVELION LTD. All rights reserved.
 * CY Protocol multiplexer (CY-MUX) — browser/Node port of cy_mux.c. Same wire format:
 *   [u8 channel][u8 flags][u16be fragLen][fragment]   flags: 1=START 2=END
 * One CY connection carries all channels (display/input/audio/clipboard/files/printer/usb/scard/...).
 * Usage (browser): var mux = new CYMux(sendBytes, onMessage); mux.recv(uint8array); mux.send(ch,data).
 */
(function (root) {
    var CH = {
        CONTROL: 0, VIDEO: 1, INPUT: 2, CURSOR: 3, AUDIO_OUT: 4, AUDIO_IN: 5,
        CLIPBOARD: 6, FILES: 7, PRINTER: 8, USB: 9, SCARD: 10, SERIAL: 11, PORT: 12, MAX: 13
    };
    var MTU = 8192, HDR = 4, F_START = 1, F_END = 2;
    function defPrio(c) {
        if (c === CH.CONTROL || c === CH.INPUT || c === CH.SCARD) return 0;
        if (c === CH.CURSOR || c === CH.AUDIO_OUT || c === CH.AUDIO_IN || c === CH.USB || c === CH.SERIAL) return 1;
        if (c === CH.VIDEO || c === CH.CLIPBOARD || c === CH.PORT) return 2;
        if (c === CH.FILES || c === CH.PRINTER) return 4;
        return 3;
    }

    function CYMux(sendBytes, onMessage) {
        this.sendBytes = sendBytes;   // function(Uint8Array) -> write to wire
        this.onMessage = onMessage;   // function(channel, Uint8Array)
        this.q = [];                  // [{ch,prio,buf,off,started}]
        this.asm = {};                // channel -> {parts:[], len}
        // recv parser state
        this._hdr = new Uint8Array(HDR); this._hn = 0;
        this._ch = 0; this._fl = 0; this._need = 0; this._got = 0; this._frag = null;
    }
    CYMux.CH = CH;

    // enqueue a complete message; priority<0 => channel default
    CYMux.prototype.send = function (ch, data, priority) {
        if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
        this.q.push({ ch: ch, prio: (priority >= 0 && priority < 8) ? priority : defPrio(ch), buf: data, off: 0, started: false, waited: 0 });
        this.pump(0);
    };
    // emit interleaved fragments (budget 0 = drain). Strict priority + aging (mirror of C).
    CYMux.prototype.pump = function (budget) {
        var sent = 0;
        while (this.q.length) {
            // pick lowest effective priority with data
            var best = -1, bestP = 1e9;
            for (var i = 0; i < this.q.length; i++) {
                var eff = this.q[i].prio - ((this.q[i].waited / 8) | 0);
                if (eff < bestP) { bestP = eff; best = i; }
            }
            var m = this.q[best];
            for (var k = 0; k < this.q.length; k++) this.q[k].waited++;
            m.waited = 0;
            var remain = m.buf.length - m.off, frag = remain > MTU ? MTU : remain;
            var flags = 0; if (!m.started) { flags |= F_START; m.started = true; } if (m.off + frag >= m.buf.length) flags |= F_END;
            var out = new Uint8Array(HDR + frag);
            out[0] = m.ch; out[1] = flags; out[2] = (frag >> 8) & 255; out[3] = frag & 255;
            out.set(m.buf.subarray(m.off, m.off + frag), HDR);
            this.sendBytes(out); sent += out.length; m.off += frag;
            if (m.off >= m.buf.length) this.q.splice(best, 1);
            if (budget && sent >= budget) break;
        }
        return sent;
    };
    CYMux.prototype.pending = function () { var n = 0; for (var i = 0; i < this.q.length; i++) n += this.q[i].buf.length - this.q[i].off; return n; };

    CYMux.prototype._feed = function (ch, flags, payload) {
        if (flags & F_START) this.asm[ch] = { parts: [], len: 0 };
        var a = this.asm[ch]; if (!a) return; // fragment without START -> drop
        if (payload && payload.length) { a.parts.push(payload); a.len += payload.length; }
        if (flags & F_END) {
            var msg = new Uint8Array(a.len), o = 0;
            for (var i = 0; i < a.parts.length; i++) { msg.set(a.parts[i], o); o += a.parts[i].length; }
            this.asm[ch] = null;
            if (this.onMessage) this.onMessage(ch, msg);
        }
    };
    CYMux.prototype.recv = function (bytes) {
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        var i = 0, L = bytes.length;
        while (i < L) {
            if (this._hn < HDR) {
                this._hdr[this._hn++] = bytes[i++];
                if (this._hn === HDR) {
                    this._ch = this._hdr[0]; this._fl = this._hdr[1];
                    this._need = (this._hdr[2] << 8) | this._hdr[3]; this._got = 0;
                    this._frag = this._need ? new Uint8Array(this._need) : null;
                    if (this._need === 0) { this._feed(this._ch, this._fl, null); this._hn = 0; }
                }
                continue;
            }
            var take = Math.min(L - i, this._need - this._got);
            this._frag.set(bytes.subarray(i, i + take), this._got); this._got += take; i += take;
            if (this._got === this._need) { this._feed(this._ch, this._fl, this._frag); this._frag = null; this._hn = 0; }
        }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = CYMux; else root.CYMux = CYMux;
})(typeof window !== 'undefined' ? window : this);
