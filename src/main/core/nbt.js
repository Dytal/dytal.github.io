// nbt.js — full Named Binary Tag parser + writer (gzip & raw), the format used by
// level.dat, scoreboard.dat, player .dat files and region (.mca) chunks.
'use strict';
const zlib = require('zlib');

const TAG = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
};

class Reader {
  constructor(buf) { this.buf = buf; this.o = 0; }
  i8() { return this.buf.readInt8(this.o++); }
  u8() { return this.buf.readUInt8(this.o++); }
  i16() { const v = this.buf.readInt16BE(this.o); this.o += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.o); this.o += 4; return v; }
  i64() {
    const big = this.buf.readBigInt64BE(this.o); this.o += 8;
    return big; // BigInt
  }
  f32() { const v = this.buf.readFloatBE(this.o); this.o += 4; return v; }
  f64() { const v = this.buf.readDoubleBE(this.o); this.o += 8; return v; }
  str() {
    const len = this.buf.readUInt16BE(this.o); this.o += 2;
    const s = this.buf.slice(this.o, this.o + len).toString('utf8'); this.o += len;
    return s;
  }
  bytes(n) { const b = this.buf.slice(this.o, this.o + n); this.o += n; return b; }
}

class Writer {
  constructor() { this.chunks = []; }
  i8(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.chunks.push(b); return this; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this.chunks.push(b); return this; }
  i16(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.chunks.push(b); return this; }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.chunks.push(b); return this; }
  i64(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(typeof v === 'bigint' ? v : BigInt(v || 0)); this.chunks.push(b); return this; }
  f32(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.chunks.push(b); return this; }
  f64(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.chunks.push(b); return this; }
  str(s) {
    const b = Buffer.from(String(s), 'utf8');
    const l = Buffer.alloc(2); l.writeUInt16BE(b.length);
    this.chunks.push(l, b); return this;
  }
  raw(buf) { this.chunks.push(buf); return this; }
  buffer() { return Buffer.concat(this.chunks); }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.Byte: return r.i8();
    case TAG.Short: return r.i16();
    case TAG.Int: return r.i32();
    case TAG.Long: return r.i64();
    case TAG.Float: return r.f32();
    case TAG.Double: return r.f64();
    case TAG.ByteArray: { const n = r.i32(); return { $bytes: r.bytes(n) }; }
    case TAG.String: return r.str();
    case TAG.List: {
      const itemType = r.u8();
      const len = r.i32();
      const items = [];
      for (let i = 0; i < len; i++) items.push(readPayload(r, itemType));
      return { $list: items, itemType };
    }
    case TAG.Compound: {
      const obj = {};
      for (;;) {
        const t = r.u8();
        if (t === TAG.End) break;
        const name = r.str();
        obj[name] = { type: t, value: readPayload(r, t) };
      }
      return { $compound: obj };
    }
    case TAG.IntArray: { const n = r.i32(); const arr = []; for (let i = 0; i < n; i++) arr.push(r.i32()); return { $intarray: arr }; }
    case TAG.LongArray: { const n = r.i32(); const arr = []; for (let i = 0; i < n; i++) arr.push(r.i64()); return { $longarray: arr }; }
    default: throw new Error(`Unknown NBT tag type ${type}`);
  }
}

function writePayload(w, type, value) {
  switch (type) {
    case TAG.Byte: w.i8(value); break;
    case TAG.Short: w.i16(value); break;
    case TAG.Int: w.i32(value); break;
    case TAG.Long: w.i64(value); break;
    case TAG.Float: w.f32(value); break;
    case TAG.Double: w.f64(value); break;
    case TAG.ByteArray: { const b = value.$bytes; w.i32(b.length); w.raw(b); break; }
    case TAG.String: w.str(value); break;
    case TAG.List: {
      const items = value.$list || [];
      const itemType = value.itemType != null ? value.itemType : (items.length ? inferType(items[0]) : TAG.End);
      w.u8(itemType); w.i32(items.length);
      for (const it of items) writePayload(w, itemType, it);
      break;
    }
    case TAG.Compound: {
      const obj = value.$compound || {};
      for (const [name, node] of Object.entries(obj)) {
        w.u8(node.type); w.str(name); writePayload(w, node.type, node.value);
      }
      w.u8(TAG.End);
      break;
    }
    case TAG.IntArray: { const arr = value.$intarray || []; w.i32(arr.length); for (const v of arr) w.i32(v); break; }
    case TAG.LongArray: { const arr = value.$longarray || []; w.i32(arr.length); for (const v of arr) w.i64(v); break; }
    default: throw new Error(`Cannot write NBT type ${type}`);
  }
}

function inferType(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? TAG.Int : TAG.Double;
  if (typeof v === 'string') return TAG.String;
  if (v && v.$compound) return TAG.Compound;
  if (v && v.$list) return TAG.List;
  if (v && v.$bytes) return TAG.ByteArray;
  return TAG.String;
}

/** Parse a full NBT file payload (root compound with name). Handles gzip/zlib/raw. */
function parse(buffer) {
  let buf = buffer;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  else if ((buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x9c || buf[1] === 0xda))) buf = zlib.inflateSync(buf);
  const r = new Reader(buf);
  const type = r.u8();
  if (type !== TAG.Compound) throw new Error('Root tag is not a compound');
  const name = r.str();
  const value = readPayload(r, TAG.Compound);
  return { name, value, consumed: r.o, total: buf.length };
}

/** Serialize { name, value } back to bytes (gzip: true by default like level.dat). */
function serialize(root, { gzip = true, level = 1 } = {}) {
  const w = new Writer();
  w.u8(TAG.Compound); w.str(root.name || '');
  writePayload(w, TAG.Compound, root.value);
  const raw = w.buffer();
  return gzip ? zlib.gzipSync(raw, { level }) : raw;
}

/** Read an .mca region file: returns [{x, z, nbt|error}] for present chunks. */
function parseRegion(buffer, { limit = 1024, onChunk = null } = {}) {
  const chunks = [];
  for (let i = 0; i < 1024 && i < limit; i++) {
    const cx = i % 32, cz = Math.floor(i / 32);
    const off = buffer.readUInt32BE(i * 4) * 4096;
    if (off === 0) continue;
    try {
      const len = buffer.readUInt32BE(off);
      const comp = buffer[off + 4];
      const data = buffer.slice(off + 5, off + 4 + len);
      let rawNbt = data;
      if (comp === 2) rawNbt = zlib.inflateSync(data);
      else if (comp === 1) rawNbt = zlib.gunzipSync(data);
      const nbt = parse(rawNbt);
      const chunk = { x: cx, z: cz, nbt };
      chunks.push(chunk);
      if (onChunk) onChunk(chunk);
    } catch (e) {
      chunks.push({ x: cx, z: cz, error: e.message });
    }
  }
  return chunks;
}

module.exports = { TAG, parse, serialize, parseRegion };
