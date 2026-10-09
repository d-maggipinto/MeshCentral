/*
 * Copyright (c) 2026 CYVELION LTD. All rights reserved.
 * CY Protocol — clipboard sync (browser/Node port of cy_clip.c). Rides the CY-MUX channel
 * CYCH_CLIPBOARD (6) directly (mux fragments/reassembles), so this is a per-message format:
 *   [u8 op][u8 flags][u16be format][u32be dataLen][data...]
 * Usage: CYClip.buildData(CYClip.FMT.TEXT, bytes) -> Uint8Array;  CYClip.parse(u8) -> {op,format,data}.
 */
(function (root) {
    var OP = { OFFER: 1, REQUEST: 2, DATA: 3, EMPTY: 4 };
    var FMT = { NONE: 0, TEXT: 1, HTML: 2, RTF: 3, PNG: 4, FILES: 5 };
    var HDR = 8;

    function toU8(x) {
        if (x == null) return new Uint8Array(0);
        if (typeof x === 'string') return new TextEncoder().encode(x);
        return x instanceof Uint8Array ? x : new Uint8Array(x);
    }

    function build(op, format, data) {
        data = toU8(data);
        var total = HDR + data.length, b = new Uint8Array(total);
        b[0] = op & 255; b[1] = 0;
        b[2] = (format >> 8) & 255; b[3] = format & 255;
        b[4] = (data.length >>> 24) & 255; b[5] = (data.length >>> 16) & 255;
        b[6] = (data.length >>> 8) & 255;  b[7] = data.length & 255;
        b.set(data, HDR);
        return b;
    }
    function buildOffer(formats) {            // formats: array of format ids
        var d = new Uint8Array(formats.length * 2);
        for (var i = 0; i < formats.length; i++) { d[i*2] = (formats[i] >> 8) & 255; d[i*2+1] = formats[i] & 255; }
        return build(OP.OFFER, FMT.NONE, d);
    }
    function buildRequest(format) { return build(OP.REQUEST, format, null); }
    function buildData(format, data) { return build(OP.DATA, format, data); }
    function buildEmpty() { return build(OP.EMPTY, FMT.NONE, null); }

    function parse(msg) {
        if (!(msg instanceof Uint8Array)) msg = new Uint8Array(msg);
        if (msg.length < HDR) return null;
        var dlen = (msg[4] * 0x1000000) + (msg[5] << 16) + (msg[6] << 8) + msg[7];
        if (dlen > msg.length - HDR) return null;     // overrun
        return {
            op: msg[0],
            format: (msg[2] << 8) | msg[3],
            data: dlen ? msg.subarray(HDR, HDR + dlen) : null,
            len: dlen
        };
    }
    function offerFormats(m) {                 // -> array of ids from a parsed OFFER
        var out = [];
        if (m && m.data) for (var i = 0; i + 2 <= m.data.length; i += 2) out.push((m.data[i] << 8) | m.data[i+1]);
        return out;
    }

    var CYClip = { OP: OP, FMT: FMT, HDR: HDR,
        build: build, buildOffer: buildOffer, buildRequest: buildRequest, buildData: buildData,
        buildEmpty: buildEmpty, parse: parse, offerFormats: offerFormats };
    if (typeof module !== 'undefined' && module.exports) module.exports = CYClip;
    else root.CYClip = CYClip;
})(typeof window !== 'undefined' ? window : this);
