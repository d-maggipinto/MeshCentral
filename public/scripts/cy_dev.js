/*
 * Copyright (c) 2026 CYVELION LTD. All rights reserved.
 * CY Protocol — cy-dev device-tunnel framing (browser/Node port of cy_dev.c). Same wire format:
 *   [u16be type][u16be size==total][payload]   types 200..204 (HELLO/ATTACH/DETACH/DATA/CTRL)
 * One `cy-dev` MeshCentral tunnel per redirected device class (printer/usb/scard/serial/disk).
 * Usage: var p = new CYDevParser(onFrame); p.feed(uint8array);  CYDev.build(type, payload)->Uint8Array.
 */
(function (root) {
    var TYPE = { HELLO: 200, ATTACH: 201, DETACH: 202, DATA: 203, CTRL: 204 };
    var HDR = 4, MAX_PAY = 0xFFFF - HDR;

    function build(type, payload) {
        if (payload == null) payload = new Uint8Array(0);
        else if (typeof payload === 'string') payload = new TextEncoder().encode(payload);
        else if (!(payload instanceof Uint8Array)) payload = new Uint8Array(payload);
        if (payload.length > MAX_PAY) throw new Error('cy-dev payload too large');
        var total = HDR + payload.length, b = new Uint8Array(total);
        b[0] = (type >> 8) & 255; b[1] = type & 255;
        b[2] = (total >> 8) & 255; b[3] = total & 255;
        b.set(payload, HDR);
        return b;
    }

    function CYDevParser(onFrame) {
        this.onFrame = onFrame;                 // function(type, Uint8Array payload)
        this._hdr = new Uint8Array(HDR); this._hn = 0;
        this._type = 0; this._need = 0; this._got = 0; this._pay = null;
    }
    CYDevParser.prototype.feed = function (bytes) {
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        var i = 0, L = bytes.length;
        while (i < L) {
            if (this._hn < HDR) {
                this._hdr[this._hn++] = bytes[i++];
                if (this._hn === HDR) {
                    this._type = (this._hdr[0] << 8) | this._hdr[1];
                    var size = (this._hdr[2] << 8) | this._hdr[3];
                    this._need = size >= HDR ? (size - HDR) : 0;
                    this._got = 0;
                    this._pay = this._need ? new Uint8Array(this._need) : null;
                    if (this._need === 0) { if (this.onFrame) this.onFrame(this._type, new Uint8Array(0)); this._hn = 0; }
                }
                continue;
            }
            var take = Math.min(L - i, this._need - this._got);
            if (this._pay) this._pay.set(bytes.subarray(i, i + take), this._got);
            this._got += take; i += take;
            if (this._got === this._need) { if (this.onFrame) this.onFrame(this._type, this._pay || new Uint8Array(0)); this._pay = null; this._hn = 0; }
        }
    };

    var CYDev = { TYPE: TYPE, HDR: HDR, MAX_PAY: MAX_PAY, build: build, Parser: CYDevParser };
    if (typeof module !== 'undefined' && module.exports) { module.exports = CYDev; module.exports.CYDevParser = CYDevParser; }
    else { root.CYDev = CYDev; root.CYDevParser = CYDevParser; }
})(typeof window !== 'undefined' ? window : this);
