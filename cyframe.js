/*
 * Copyright (c) 2026 CYVELION LTD. All rights reserved.
 *
 * CY Protocol reference framing — a clean-room, improved successor to the NX
 * remote-desktop protocol, developed by CYVELION LTD. Not derived from any
 * NoMachine source code; built from a behavioral specification (see CY_PROTOCOL.md).
 *
 * Why CY is a better protocol than NX (summary; full rationale in CY_PROTOCOL.md §0):
 *   - No cleartext STARTTLS prologue (NX leaked "NXSH-/NXD-" before TLS).
 *   - No redundant inner cipher by default (NX double-encrypted: Blowfish/AES *inside* TLS).
 *   - Modern AEAD (AES-256-GCM / ChaCha20-Poly1305) + HKDF keys when e2e is needed
 *     (NX used 64-bit-block Blowfish-CFB64 / AES-128-CBC with raw cookie-as-key, no KDF).
 *   - Compact binary/CBOR control (NX used fragile ASCII "NX> NNN" lines).
 *   - Codec negotiation H.264/VP8/AV1 + adaptive bitrate (NX was H.264-only).
 *   - OS-agnostic HID input + damage rects (NX was X11-centric; emitted keycode warnings).
 *   - Reuses MeshCentral identity/auth (NX used self-signed TOFU + passwords in-band).
 */
'use strict';

// CY command codes carried in the MeshCentral desktop stream ([cmd u16be][size u16be] header).
// Chosen to not collide with existing MNG_KVM_* codes (1-18, 59, 82, 88, 89).
const CY = {
  HELLO:            90, // viewer -> agent : capabilities (CBOR)
  CONFIG:           91, // agent  -> viewer: chosen codec/audio + screens (CBOR)
  KEYFRAME:         92, // agent  -> viewer: full codec frame (I-frame)
  DELTA:            93, // agent  -> viewer: inter codec frame (P-frame)
  REQUEST_KEYFRAME: 94, // viewer -> agent
  AUDIO:            95, // agent  -> viewer: Opus frame
  CURSOR:           96, // agent  -> viewer: cursor shape/pos
  STATS:            97, // viewer -> agent : RTT/loss/fps telemetry
};
const CY_SET = new Set(Object.values(CY));
const PROTO_VERSION = 1;

// Build a CY frame: Buffer([cmd u16be][size u16be][payload]). size = payload length.
function build(cmd, payload) {
  payload = payload || Buffer.alloc(0);
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt16BE(cmd, 0);
  h.writeUInt16BE((payload.length + 4) & 0xffff, 2); // total frame length (MeshCentral convention)
  return Buffer.concat([h, payload]);
}

// Parse the header of a Mesh desktop frame.
function header(buf) {
  if (!buf || buf.length < 4) return null;
  return { command: buf.readUInt16BE(0), size: buf.readUInt16BE(2) };
}

const isCY = (cmd) => CY_SET.has(cmd);

// Default negotiable capabilities (viewer side).
function defaultCaps() {
  return {
    v: PROTO_VERSION,
    codecs: ['h264', 'vp8', 'av1', 'jpeg'], // jpeg = fallback to legacy tiles
    audio: ['opus'],
    features: ['cursor', 'clipboard', 'files', 'stats'],
  };
}

module.exports = { CY, CY_SET, PROTO_VERSION, build, header, isCY, defaultCaps };
