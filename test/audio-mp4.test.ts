import { describe, it, expect } from "vitest";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { parseInit, rewriteInit } from "../src/audio/mp4/init";
import { parseSegment, decryptSegment, decryptSample, localAesBackend } from "../src/audio/mp4/segment";
import type { SampleEncryption, AesBackend } from "../src/audio/mp4/types";

// ---- box helpers for synthetic fMP4 ----

function u32be(v: number): Buffer { const b=Buffer.alloc(4); b.writeUInt32BE(v,0); return b; }
function makeBoxTest(type: string, payload: Buffer): Buffer {
  const h=Buffer.alloc(8); h.writeUInt32BE(8+payload.length,0); h.write(type,4,4,"ascii"); return Buffer.concat([h,payload]);
}
function makeFullBoxTest(type:string, version:number, flags:number, payload: Buffer): Buffer {
  const hdr=Buffer.alloc(4); hdr.writeUInt8(version,0); hdr.writeUInt8((flags>>16)&0xff,1); hdr.writeUInt8((flags>>8)&0xff,2); hdr.writeUInt8(flags&0xff,3);
  return makeBoxTest(type, Buffer.concat([hdr,payload]));
}

// AES helpers (no padding)
function aesEncrypt(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const c = createCipheriv("aes-128-cbc", key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]);
}
function aesDecrypt(cipher: Buffer, key: Buffer, iv: Buffer): Buffer {
  const d = createDecipheriv("aes-128-cbc", key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(cipher), d.final()]);
}

// Encryption mirrors decrypt logic (for test vector generation)
function encryptCbcsFull(plain: Buffer, key: Buffer, iv: Buffer): Buffer {
  const out = Buffer.from(plain);
  const trunc = out.length & ~0xf;
  if (trunc===0) return out;
  const enc = aesEncrypt(Buffer.from(out.subarray(0,trunc)), key, iv);
  enc.copy(out,0);
  return out;
}
function encryptCbcsPattern(plain: Buffer, key: Buffer, iv: Buffer, cryptBlocks:number, skipBlocks:number): Buffer {
  if (cryptBlocks===0 && skipBlocks===0) return encryptCbcsFull(plain,key,iv);
  const cryptLen=cryptBlocks*16, skipLen=skipBlocks*16;
  if (cryptLen===0) return Buffer.from(plain);
  if (plain.length < cryptLen) return Buffer.from(plain);
  let count=0, pos=0;
  while (pos+cryptLen <= plain.length){ count++; pos+=cryptLen; if(pos+skipLen>plain.length) break; pos+=skipLen; }
  if(count===0) return Buffer.from(plain);
  const total=count*cryptLen;
  const gathered=Buffer.alloc(total);
  let w=0, r=0;
  for(let i=0;i<count;i++){ plain.copy(gathered,w,r,r+cryptLen); w+=cryptLen; r+=cryptLen; if(i<count-1) r+=skipLen; }
  const enc = aesEncrypt(gathered, key, iv);
  const out=Buffer.from(plain);
  w=0; r=0;
  for(let i=0;i<count;i++){ enc.copy(out,r,w,w+cryptLen); w+=cryptLen; r+=cryptLen; if(i<count-1) r+=skipLen; }
  return out;
}
function encryptCencRuns(plain: Buffer, key: Buffer, iv: Buffer, subsamples: {clear:number,encrypted:number}[]|null): Buffer {
  const out=Buffer.from(plain);
  const effIv = iv.length===8 ? Buffer.concat([iv, Buffer.alloc(8,0)]) : iv;
  if(subsamples && subsamples.length>0){
    let pos=0;
    for(const ss of subsamples){ pos+=ss.clear; if(ss.encrypted>0){ const slice=plain.subarray(pos,pos+ss.encrypted); const enc=aesEncrypt(Buffer.from(slice),key,effIv); enc.copy(out,pos); pos+=ss.encrypted; } }
  } else {
    // full sample
    if(plain.length===0) return out;
    if(plain.length%16!==0){ const trunc=plain.length & ~0xf; if(trunc>0){ const enc=aesEncrypt(Buffer.from(plain.subarray(0,trunc)),key,effIv); enc.copy(out,0); } return out; }
    const enc=aesEncrypt(Buffer.from(plain),key,effIv); enc.copy(out,0);
  }
  return out;
}
function encryptSampleTest(plain: Buffer, key: Buffer, iv: Buffer, info: SampleEncryption, subs?: {clear:number,encrypted:number}[]|null): Buffer {
  if(info.scheme==="cbcs"){
    const eff = info.constantIv ?? iv;
    const iv16 = eff.length===16? eff : Buffer.concat([eff, Buffer.alloc(16-eff.length,0)]).subarray(0,16);
    if(subs && subs.length>0){
      const out=Buffer.from(plain);
      let pos=0;
      for(const ss of subs){ pos+=ss.clear; if(ss.encrypted>0){ const slice=plain.subarray(pos,pos+ss.encrypted); let enc: Buffer; if(info.cryptByteBlock===0 && info.skipByteBlock===0) enc=encryptCbcsFull(Buffer.from(slice),key,iv16); else enc=encryptCbcsPattern(Buffer.from(slice),key,iv16,info.cryptByteBlock,info.skipByteBlock); enc.copy(out,pos); pos+=ss.encrypted; } } return out;
    } else {
      if(info.cryptByteBlock===0 && info.skipByteBlock===0) return encryptCbcsFull(plain,key,iv16);
      return encryptCbcsPattern(plain,key,iv16,info.cryptByteBlock,info.skipByteBlock);
    }
  } else {
    return encryptCencRuns(plain,key,iv,subs??null);
  }
}

// Builders

function buildTenc(info: { scheme:string, kid:Buffer, perIv:number, constIv:Buffer|null, crypt:number, skip:number }): Buffer {
  // ISO/IEC 23001-7 layout, verified against a real Apple Music init segment:
  // v1 = reserved(8), crypt(4)|skip(4), isProtected(8), perSampleIvSize(8),
  //      KID(16), constantIvSize(8), constantIv[...]
  const version = info.scheme === "cbcs" ? 1 : 0;
  const payloadParts: Buffer[] = [];
  payloadParts.push(Buffer.from([0])); // reserved
  if (version === 1) {
    payloadParts.push(Buffer.from([((info.crypt & 0x0f) << 4) | (info.skip & 0x0f)]));
  }
  payloadParts.push(Buffer.from([1])); // isProtected
  payloadParts.push(Buffer.from([info.perIv]));
  payloadParts.push(info.kid);
  if (version === 1 && info.perIv === 0) {
    const cIv = info.constIv ?? Buffer.alloc(0);
    payloadParts.push(Buffer.from([cIv.length]));
    if (cIv.length) payloadParts.push(cIv);
  }
  return makeFullBoxTest("tenc", version, 0, Buffer.concat(payloadParts));
}

function buildInit(opts:{ trackId:number, scheme:"cbcs"|"cenc"|"cbc1", originalFormat:string, perIv:number, constIv:Buffer|null, crypt:number, skip:number, kid:Buffer }): Buffer {
  const kid = opts.kid;
  const tenc = buildTenc({ scheme:opts.scheme,kid,perIv:opts.perIv,constIv:opts.constIv,crypt:opts.crypt,skip:opts.skip });
  const schi = makeBoxTest("schi", tenc);
  const schmPayload = Buffer.concat([ Buffer.from(opts.scheme,"ascii"), u32be(0x00010000) ]); // scheme_type 4 + version 4
  const schm = makeFullBoxTest("schm", 0, 0, schmPayload);
  const frma = makeBoxTest("frma", Buffer.from(opts.originalFormat,"ascii"));
  const sinf = makeBoxTest("sinf", Buffer.concat([frma, schm, schi]));
  // enca sample entry
  const encaFields = Buffer.alloc(28);
  // reserved 6 + data_ref 2 etc zeroed except channelcount etc not needed
  encaFields.writeUInt16BE(1,6); // data_reference_index 1
  // channelcount etc leave 0
  const enca = makeBoxTest("enca", Buffer.concat([encaFields, sinf]));
  const stsd = makeFullBoxTest("stsd", 0, 0, Buffer.concat([u32be(1), enca]));
  // sbgp/sgpd seam/seig for removal test (added optionally; builder will include by flag)
  let sbgp: Buffer | null = null;
  let sgpd: Buffer | null = null;
  if(opts.scheme==="cbcs"){ // include for cbcs case to test removal
    const sbgpPayload = Buffer.concat([ Buffer.from("seam","ascii"), Buffer.alloc(4,0), u32be(0)]); // grouping_type + param? simplified: version/flags already in fullbox header, payload first 4 is grouping_type, next 4 is group count? Our parser expects grouping at offset 4
    // sbgp fullbox: version/flags + grouping_type(4) + grouping_type_parameter(4?) Actually we produce 4 grouping + 4 param + entries
    // For simplicity produce 8 bytes payload after header: grouping_type 4 + entry count etc.
    sbgp = makeFullBoxTest("sbgp", 0, 0, Buffer.concat([Buffer.from("seam","ascii"), u32be(0), u32be(1), u32be(1), u32be(1)]));
    sgpd = makeFullBoxTest("sgpd", 0, 0, Buffer.concat([Buffer.from("seig","ascii"), u32be(0), u32be(0)]));
  }
  const stblPayloadParts: Buffer[] = [stsd];
  if(sbgp) stblPayloadParts.push(sbgp);
  if(sgpd) stblPayloadParts.push(sgpd);
  stblPayloadParts.push(makeBoxTest("stts", Buffer.alloc(0)));
  const stbl = makeBoxTest("stbl", Buffer.concat(stblPayloadParts));
  const minf = makeBoxTest("minf", Buffer.concat([ makeBoxTest("smhd", Buffer.alloc(8)), makeBoxTest("dinf", makeBoxTest("dref", Buffer.alloc(0))), stbl ]));
  const mdhd = makeFullBoxTest("mdhd", 0, 0, Buffer.alloc(20));
  const hdlr = makeFullBoxTest("hdlr", 0, 0, Buffer.concat([u32be(0), Buffer.from("soun","ascii"), Buffer.alloc(12,0), Buffer.from("SoundHandler\0","ascii")]));
  const mdia = makeBoxTest("mdia", Buffer.concat([mdhd, hdlr, minf]));
  // tkhd
  const tkhdPayload = Buffer.alloc(84);
  tkhdPayload.writeUInt8(0,0); // version
  // flags at 1-3
  tkhdPayload.writeUInt32BE(opts.trackId,12);
  const tkhd = makeFullBoxTest("tkhd", 0, 0x000007, tkhdPayload.subarray(4)); // makeFull will add header, so we trimmed
  // Actually makeFull adds version/flags, so payload should be after that: need to build correctly
  // Simpler: construct tkhd directly
  const tkhd2 = (()=> {
    const p = Buffer.alloc(92);
    // We'll build box manually: use makeFull's logic: payload after version/flags is our custom
    const inner = Buffer.alloc(80);
    // after version/flags: creation 4, mod 4, trackID 4 etc
    // At offset 12 from payload start? In tkhd version 0, track_ID at byte 12 of payload (after version/flags)
    // So inner layout: creation 4 (0), mod 4 (0), trackID 4, reserved 4, duration 4...
    inner.writeUInt32BE(opts.trackId, 8); // offset 8 inside inner? Let's verify: inner offset 0 creation, 4 mod, 8 trackID
    return makeFullBoxTest("tkhd", 0, 0x000007, inner);
  })();
  const trak = makeBoxTest("trak", Buffer.concat([tkhd2, mdia]));
  const mvhd = makeFullBoxTest("mvhd", 0, 0, Buffer.alloc(96));
  const mvex = makeBoxTest("mvex", Buffer.alloc(0));
  const moov = makeBoxTest("moov", Buffer.concat([mvhd, trak, mvex]));
  const ftyp = makeBoxTest("ftyp", Buffer.concat([Buffer.from("isom","ascii"), u32be(0), Buffer.from("isomiso2mp41","ascii")]));
  return Buffer.concat([ftyp, moov]);
}

// Segment builder

function buildSenc(perIvSize:number, samples:{ iv:Buffer|null, subs:{clear:number,encrypted:number}[]|null }[]): Buffer {
  // Determine flags: bit 1 = override? 0x01? subsample = 0x02
  const hasSubs = samples.some(s=> s.subs && s.subs.length>0);
  const flags = hasSubs ? 0x02 : 0x00;
  const count = samples.length;
  const parts: Buffer[] = [ u32be(count) ];
  for(const s of samples){
    if(perIvSize>0 && s.iv) parts.push(s.iv);
    else if(perIvSize>0 && !s.iv) parts.push(Buffer.alloc(perIvSize,0));
    if(hasSubs){
      const subs = s.subs ?? [];
      parts.push(Buffer.alloc(2)); parts[parts.length-1]!.writeUInt16BE(subs.length,0);
      for(const ss of subs){
        const e = Buffer.alloc(6);
        e.writeUInt16BE(ss.clear,0);
        e.writeUInt32BE(ss.encrypted,2);
        parts.push(e);
      }
    }
  }
  return makeFullBoxTest("senc", 0, flags, Buffer.concat(parts));
}

function buildTrun(sampleSizes:number[], dataOffset:number): Buffer {
  const flags = 0x000001 | 0x000200; // data_offset + sample_size
  const payload = Buffer.concat([ u32be(dataOffset), u32be(sampleSizes.length), ...sampleSizes.map(s=>u32be(s)) ]);
  // Actually trun payload: data_offset (4 if present), sample_count (4), entries...
  // But flags require correct ordering: data_offset, first_flags?, durations, sizes etc.
  // Our parseTrun expects data_offset then sample_count then entries with size only.
  // However payload above includes data_offset as first 4 then count then sizes. Our makeFull will prepend version/flags, so need to ensure data_offset considered.
  return makeFullBoxTest("trun", 0, flags, payload);
}
function buildTfhd(trackId:number): Buffer { return makeFullBoxTest("tfhd", 0, 0, u32be(trackId)); }
function buildMfhd(seq:number): Buffer { return makeFullBoxTest("mfhd", 0, 0, u32be(seq)); }
function buildTfdt(base:number): Buffer { const b=Buffer.alloc(8); b.writeBigUInt64BE(BigInt(base),0); return makeFullBoxTest("tfdt", 1, 0, b); }

function buildSegment(opts:{ trackId:number, key:Buffer, info:SampleEncryption, planes: { plain:Buffer, iv?:Buffer, subs?:{clear:number,encrypted:number}[]|null}[], seq?:number, includeSbgp?:boolean }): Buffer {
  const seq = opts.seq ?? 1;
  // Prepare ciphertext payload
  const mdatPlainParts: Buffer[] = [];
  const sencEntries: { iv:Buffer|null, subs:{clear:number,encrypted:number}[]|null }[] = [];
  const sampleSizes: number[] = [];
  for(const pl of opts.planes){
    const plain = pl.plain;
    sampleSizes.push(plain.length);
    const iv = pl.iv ?? (opts.info.constantIv ?? Buffer.alloc(0));
    const subs = pl.subs ?? null;
    const ct = encryptSampleTest(plain, opts.key, iv, opts.info, subs);
    mdatPlainParts.push(ct);
    // senc entry iv: for cbcs constant 0 size => null, for cenc use iv
    let sencIv: Buffer|null = null;
    if(opts.info.perSampleIvSize>0){
      // perSampleIvSize determines iv to store
      const rawIv = pl.iv!;
      sencIv = rawIv;
    }
    sencEntries.push({ iv: sencIv, subs });
  }
  const mdatPayload = Buffer.concat(mdatPlainParts);
  const mdat = makeBoxTest("mdat", mdatPayload);

  // Build senc
  const senc = buildSenc(opts.info.perSampleIvSize, sencEntries);

  // Build traf
  // Estimate moof size to compute dataOffset: moof size =?
  // We'll build traf without trun first to compute
  // Simpler compute dataOffset as 8(mdat header)+ moof estimated? But we'll brute: build tentative traf with trun dataOffset 0, then compute moof size, then rebuild with correct offset.
  const tfhd = buildTfhd(opts.trackId);
  const tfdt = buildTfdt(0);
  // tentative trun
  let trafTmp = makeBoxTest("traf", Buffer.concat([tfhd, tfdt, buildTrun(sampleSizes, 0), senc]));
  let moofTmp = makeBoxTest("moof", Buffer.concat([buildMfhd(seq), trafTmp]));
  const dataOffset = moofTmp.length + 8; // mdat header 8
  const trun = buildTrun(sampleSizes, dataOffset);
  let traf: Buffer;
  const trafParts: Buffer[] = [tfhd, tfdt, trun, senc];
  if(opts.includeSbgp){
    const sbgp = makeFullBoxTest("sbgp", 0, 0, Buffer.concat([Buffer.from("seam","ascii"), u32be(0), u32be(0)]));
    trafParts.push(sbgp);
  }
  traf = makeBoxTest("traf", Buffer.concat(trafParts));
  const moof = makeBoxTest("moof", Buffer.concat([buildMfhd(seq), traf]));
  return Buffer.concat([moof, mdat]);
}

function buildTwoMoofSegment(first: Buffer, second: Buffer): Buffer {
  return Buffer.concat([first, second]);
}

// ---- Tests ----

describe("mp4 fMP4 decryption", ()=>{
  const key = Buffer.from("00112233445566778899aabbccddeeff","hex");
  const kid = Buffer.from("11223344556677889900aabbccddeeff","hex");
  const constIv = Buffer.from("0102030405060708090a0b0c0d0e0f10","hex");

  it("1 cbcs full-sample constant IV", ()=>{
    const info: SampleEncryption = { scheme:"cbcs", defaultKid:kid, perSampleIvSize:0, constantIv:constIv, cryptByteBlock:0, skipByteBlock:0, originalFormat:"alac" };
    const plain = Buffer.alloc(64, 0x41); // 64 bytes
    for(let i=0;i<plain.length;i++) plain[i]= i &0xff;
    const initBuf = buildInit({ trackId:1, scheme:"cbcs", originalFormat:"alac", perIv:0, constIv, crypt:0, skip:0, kid });
    const parsed = parseInit(initBuf);
    expect(parsed.trackId).toBe(1);
    expect(parsed.encryption.scheme).toBe("cbcs");
    expect(parsed.encryption.constantIv!.equals(constIv)).toBe(true);

    const seg = buildSegment({ trackId:1, key, info, planes:[{plain, iv:constIv}] });
    const ps = parseSegment(seg);
    expect(ps.trackId).toBe(1);
    expect(ps.samples.length).toBe(1);
    // decryptSample directly
    const sencIv = ps.samples[0]!.iv; // null for cbcs
    const encrypted = encryptSampleTest(plain, key, constIv, info, null);
    const dec = decryptSample(encrypted, key, constIv, info);
    expect(dec.equals(plain)).toBe(true);

    const decSeg = decryptSegment(seg, key, info);
    // extract decrypted mdat payload
    // Parse decrypted segment: should have no senc
    const top = (()=>{ const v=decSeg; return v; })();
    // Verify senc removed
    expect(decSeg.includes(Buffer.from("senc","ascii"))).toBe(false);
    // Verify payload restored
    const parsed2 = parseSegment(decSeg); // after decryption, senc removed, but parseSegment after decrypt will have no iv? Our new parse after decrypt expects still senc? But decrypt removes senc, so parsing again will not have senc. So verify via direct mdat extraction
    // Directly check mdat payload equals plain
    // Find mdat box
    const mdatOff = decSeg.indexOf(Buffer.from("mdat","ascii"));
    const mdatSize = decSeg.readUInt32BE(mdatOff-4);
    const mdatPayload = decSeg.subarray(mdatOff+4, mdatOff-4+mdatSize);
    expect(mdatPayload.equals(plain)).toBe(true);
  });

  it("2 cbcs subsample pattern", ()=>{
    const info: SampleEncryption = { scheme:"cbcs", defaultKid:kid, perSampleIvSize:0, constantIv:constIv, cryptByteBlock:1, skipByteBlock:9, originalFormat:"mp4a" };
    // For pattern 1:9, each 10 blocks => 1 encrypted, 9 skip. Sample 10*16=160 bytes => 1 encrypted block at start, then 9 clear.
    const plain = Buffer.alloc(160, 0);
    for(let i=0;i<plain.length;i++) plain[i]= (i*3)&0xff;
    const subs = [{ clear:0, encrypted:160 }]; // single subsample covering whole sample but pattern will decrypt only stripes
    const seg = buildSegment({ trackId:2, key, info, planes:[{plain, iv:constIv, subs }] });
    const ps = parseSegment(seg);
    expect(ps.samples[0]!.subsamples).toEqual(subs);
    const encrypted = encryptSampleTest(plain, key, constIv, info, subs);
    const dec = decryptSample(encrypted, key, constIv, info, subs);
    expect(dec.equals(plain)).toBe(true);

    const decSeg = decryptSegment(seg, key, info);
    const mdatOff = decSeg.indexOf(Buffer.from("mdat","ascii"));
    const mdatSize = decSeg.readUInt32BE(mdatOff-4);
    const payload = decSeg.subarray(mdatOff+4, mdatOff-4+mdatSize);
    expect(payload.equals(plain)).toBe(true);
  });

  it("3 cenc per-sample 8-byte IV", ()=>{
    const info: SampleEncryption = { scheme:"cenc", defaultKid:kid, perSampleIvSize:8, constantIv:null, cryptByteBlock:0, skipByteBlock:0, originalFormat:"mp4a" };
    const iv8 = Buffer.from("aabbccddeeff0011","hex"); // 8
    const plain = Buffer.alloc(32, 0x55);
    for(let i=0;i<plain.length;i++) plain[i]=(i*7)&0xff;
    const initBuf = buildInit({ trackId:3, scheme:"cenc", originalFormat:"mp4a", perIv:8, constIv:null, crypt:0, skip:0, kid });
    expect(parseInit(initBuf).encryption.perSampleIvSize).toBe(8);

    const seg = buildSegment({ trackId:3, key, info, planes:[{plain, iv:iv8}] });
    const ps = parseSegment(seg);
    expect(ps.samples[0]!.iv!.length).toBe(8);
    expect(ps.samples[0]!.iv!.equals(iv8)).toBe(true);
    const enc = encryptSampleTest(plain, key, iv8, info, null);
    const dec = decryptSample(enc, key, iv8, info);
    expect(dec.equals(plain)).toBe(true);
    const decSeg = decryptSegment(seg, key, info);
    const mdatOff = decSeg.indexOf(Buffer.from("mdat","ascii"));
    const mdatSize = decSeg.readUInt32BE(mdatOff-4);
    const pay = decSeg.subarray(mdatOff+4, mdatOff-4+mdatSize);
    expect(pay.equals(plain)).toBe(true);
  });

  it("4 cenc per-sample 16-byte IV", ()=>{
    const info: SampleEncryption = { scheme:"cenc", defaultKid:kid, perSampleIvSize:16, constantIv:null, cryptByteBlock:0, skipByteBlock:0, originalFormat:"mp4a" };
    const iv16 = Buffer.from("00112233445566778899aabbccddeeff","hex");
    const plain = Buffer.alloc(48, 0);
    for(let i=0;i<plain.length;i++) plain[i]= (255-i)&0xff;
    const seg = buildSegment({ trackId:4, key, info, planes:[{plain, iv:iv16}] });
    const ps = parseSegment(seg);
    expect(ps.samples[0]!.iv!.length).toBe(16);
    const enc = encryptSampleTest(plain, key, iv16, info, null);
    expect(decryptSample(enc, key, iv16, info).equals(plain)).toBe(true);
    const decSeg = decryptSegment(seg, key, info);
    const off = decSeg.indexOf(Buffer.from("mdat","ascii"));
    const sz = decSeg.readUInt32BE(off-4);
    expect(decSeg.subarray(off+4, off-4+sz).equals(plain)).toBe(true);
  });

  it("5 two moofs in one chunk", ()=>{
    const info: SampleEncryption = { scheme:"cbcs", defaultKid:kid, perSampleIvSize:0, constantIv:constIv, cryptByteBlock:0, skipByteBlock:0, originalFormat:"alac" };
    const plain1 = Buffer.alloc(32, 0x11);
    const plain2 = Buffer.alloc(32, 0x22);
    for(let i=0;i<32;i++){ plain1[i]=i; plain2[i]=32+i; }
    const seg1 = buildSegment({ trackId:1, key, info, planes:[{plain:plain1, iv:constIv}], seq:1 });
    const seg2 = buildSegment({ trackId:1, key, info, planes:[{plain:plain2, iv:constIv}], seq:2 });
    const combined = buildTwoMoofSegment(seg1, seg2);
    const ps = parseSegment(combined);
    expect(ps.samples.length).toBe(2);
    expect(ps.samples[0]!.size).toBe(32);
    expect(ps.samples[1]!.size).toBe(32);
    const decSeg = decryptSegment(combined, key, info);
    // Both mdats decrypted
    // Count mdat boxes: should be 2
    let cnt=0, pos=0;
    while((pos=decSeg.indexOf(Buffer.from("mdat","ascii"),pos))!==-1){ cnt++; pos+=4; }
    expect(cnt).toBe(2);
    // Ensure both payloads correct: find first mdat payload
    // Parse via splitting: parse boxes
    // Simple check: decrypted segment contains both plaintexts sequentially somewhere
    expect(decSeg.includes(plain1)).toBe(true);
    expect(decSeg.includes(plain2)).toBe(true);
    // No senc left
    expect(decSeg.includes(Buffer.from("senc","ascii"))).toBe(false);
  });

  it("6 non-16-aligned cbcs sample keeps its tail", ()=>{
    const info: SampleEncryption = { scheme:"cbcs", defaultKid:kid, perSampleIvSize:0, constantIv:constIv, cryptByteBlock:0, skipByteBlock:0, originalFormat:"alac" };
    const plain = Buffer.alloc(30, 0); // 30 = 16 +14 tail
    for(let i=0;i<plain.length;i++) plain[i]= (i*11)&0xff;
    const seg = buildSegment({ trackId:1, key, info, planes:[{plain, iv:constIv}] });
    const encrypted = encryptSampleTest(plain, key, constIv, info, null);
    // Tail (bytes 16..29) should be untouched
    expect(encrypted.subarray(16).equals(plain.subarray(16))).toBe(true);
    // First 16 bytes should be encrypted (different)
    expect(encrypted.subarray(0,16).equals(plain.subarray(0,16))).toBe(false);
    const dec = decryptSample(encrypted, key, constIv, info);
    expect(dec.equals(plain)).toBe(true);

    const decSeg = decryptSegment(seg, key, info);
    const off = decSeg.indexOf(Buffer.from("mdat","ascii"));
    const sz = decSeg.readUInt32BE(off-4);
    expect(decSeg.subarray(off+4, off-4+sz).equals(plain)).toBe(true);
  });

  it("7 rewriteInit renames enca -> original format and removes encryption boxes", ()=>{
    const kid2 = kid;
    const initBuf = buildInit({ trackId:7, scheme:"cbcs", originalFormat:"alac", perIv:0, constIv, crypt:1, skip:9, kid: kid2 });
    expect(initBuf.includes(Buffer.from("enca","ascii"))).toBe(true);
    expect(initBuf.includes(Buffer.from("sinf","ascii"))).toBe(true);
    expect(initBuf.includes(Buffer.from("tenc","ascii"))).toBe(true);
    // sbgp/sgpd present
    expect(initBuf.includes(Buffer.from("seam","ascii"))).toBe(true);
    const { init: rewritten, info } = rewriteInit(initBuf);
    expect(info.encryption.originalFormat).toBe("alac");
    expect(info.trackId).toBe(7);
    expect(rewritten.includes(Buffer.from("enca","ascii"))).toBe(false);
    expect(rewritten.includes(Buffer.from("alac","ascii"))).toBe(true);
    expect(rewritten.includes(Buffer.from("sinf","ascii"))).toBe(false);
    expect(rewritten.includes(Buffer.from("schm","ascii"))).toBe(false);
    expect(rewritten.includes(Buffer.from("tenc","ascii"))).toBe(false);
    expect(rewritten.includes(Buffer.from("seam","ascii"))).toBe(false);
    expect(rewritten.includes(Buffer.from("seig","ascii"))).toBe(false);
    // ftyp preserved byte-identical
    const ftypOriginal = initBuf.subarray(0, initBuf.indexOf(Buffer.from("moov","ascii"))-4);
    const ftypRewritten = rewritten.subarray(0, rewritten.indexOf(Buffer.from("moov","ascii"))-4);
    expect(ftypRewritten.equals(ftypOriginal)).toBe(true);
    // Parsing rewritten should throw (no encrypted track)
    expect(()=> parseInit(rewritten)).toThrow();
  });

  it("8 tampered input throws", ()=>{
    const info: SampleEncryption = { scheme:"cenc", defaultKid:kid, perSampleIvSize:8, constantIv:null, cryptByteBlock:0, skipByteBlock:0, originalFormat:"mp4a" };
    const iv8 = Buffer.from("0102030405060708","hex");
    const plain = Buffer.alloc(16,0x99);
    const seg = buildSegment({ trackId:1, key, info, planes:[{plain, iv:iv8}] });
    const initBuf = buildInit({ trackId:1, scheme:"cenc", originalFormat:"mp4a", perIv:8, constIv:null, crypt:0, skip:0, kid });
    // Tamper: truncate init
    const truncated = initBuf.subarray(0, 10);
    expect(()=> parseInit(truncated)).toThrow();
    // Tamper: corrupt box size to exceed bounds
    const bad = Buffer.from(initBuf);
    bad.writeUInt32BE(0xfffffff, 0); // first box size huge
    expect(()=> parseInit(bad)).toThrow();

    const badSeg = Buffer.from(seg);
    // corrupt moof size to be 1 with largesize but truncated
    badSeg[2]=0xff;
    expect(()=> parseSegment(badSeg)).toThrow();
    expect(()=> decryptSegment(badSeg, key, info)).toThrow();
    // Wrong key length should throw
    expect(()=> decryptSample(plain, Buffer.alloc(8), iv8, info)).toThrow();
    // parseInit with no moov
    expect(()=> parseInit(Buffer.from("000000086674797069736f6d00000000","hex"))).toThrow();
  });

  it("cenc subsample encryption round-trip", ()=>{
    const info: SampleEncryption = { scheme:"cenc", defaultKid:kid, perSampleIvSize:16, constantIv:null, cryptByteBlock:0, skipByteBlock:0, originalFormat:"mp4a" };
    const iv16 = Buffer.from("aabbccddeeff00112233445566778899","hex");
    // sample 48 bytes partitioned: 8 clear +16 enc +8 clear +16 enc
    const plain = Buffer.alloc(48,0);
    for(let i=0;i<48;i++) plain[i]=i;
    const subs = [{clear:8, encrypted:16},{clear:8, encrypted:16}];
    const seg = buildSegment({ trackId:5, key, info, planes:[{plain, iv:iv16, subs}] });
    const ps = parseSegment(seg);
    expect(ps.samples[0]!.subsamples).toEqual(subs);
    const enc = encryptSampleTest(plain, key, iv16, info, subs);
    // Clear bytes should be unchanged
    expect(enc.subarray(0,8).equals(plain.subarray(0,8))).toBe(true);
    expect(enc.subarray(24,32).equals(plain.subarray(24,32))).toBe(true);
    const dec = decryptSample(enc, key, iv16, info, subs);
    expect(dec.equals(plain)).toBe(true);
    const decSeg = decryptSegment(seg, key, info);
    const off = decSeg.indexOf(Buffer.from("mdat","ascii"));
    const sz = decSeg.readUInt32BE(off-4);
    expect(decSeg.subarray(off+4, off-4+sz).equals(plain)).toBe(true);
  });

  it("backend injection and trailing partial block", ()=>{
    // Verify that AesBackend is invoked with only complete blocks and matches localAesBackend
    const info: SampleEncryption = { scheme:"cbcs", defaultKid:kid, perSampleIvSize:0, constantIv:constIv, cryptByteBlock:0, skipByteBlock:0, originalFormat:"alac" };
    const plain = Buffer.alloc(30,0);
    for(let i=0;i<30;i++) plain[i]=(i*11)&0xff;
    const encrypted = encryptSampleTest(plain, key, constIv, info, null);
    // Mock backend that records calls and delegates to real AES
    const calls: { len:number, ivLen:number }[] = [];
    let backendCalls = 0;
    const mockBackend: AesBackend = {
      decrypt(data: Buffer, iv: Buffer): Buffer {
        backendCalls++;
        calls.push({ len: data.length, ivLen: iv.length });
        // Only complete blocks should be sent: for 30 bytes, only 16
        expect(data.length % 16).toBe(0);
        expect(data.length).toBe(16);
        expect(iv.equals(constIv)).toBe(true);
        const d = createDecipheriv("aes-128-cbc", key, iv);
        d.setAutoPadding(false);
        return Buffer.concat([d.update(data), d.final()]);
      },
    };
    const decViaBackend = decryptSample(encrypted, mockBackend, constIv, info);
    expect(decViaBackend.equals(plain)).toBe(true);
    expect(backendCalls).toBe(1);
    expect(calls[0]!.len).toBe(16);
    // Compare with localAesBackend path - should match exactly
    const local = localAesBackend(key);
    const decViaLocal = decryptSample(encrypted, local, constIv, info);
    expect(decViaLocal.equals(plain)).toBe(true);
    expect(decViaLocal.equals(decViaBackend)).toBe(true);

    // decryptSegment with backend: build a segment and ensure backend is called
    const seg = buildSegment({ trackId:1, key, info, planes:[{plain, iv:constIv}] });
    let segCalls = 0;
    const segMock: AesBackend = {
      decrypt(data: Buffer, iv: Buffer): Buffer {
        segCalls++;
        expect(data.length %16).toBe(0);
        return local.decrypt(data, iv);
      },
    };
    const decSegViaBackend = decryptSegment(seg, segMock, info);
    const decSegViaBuffer = decryptSegment(seg, key, info);
    expect(decSegViaBackend.equals(decSegViaBuffer)).toBe(true);
    expect(segCalls).toBeGreaterThan(0);
    // Verify localAesBackend helper directly decrypts a known vector
    const vecPlain = Buffer.alloc(16, 0x42);
    const vecIv = constIv;
    const vecCt = aesEncrypt(vecPlain, key, vecIv);
    expect(local.decrypt(vecCt, vecIv).equals(vecPlain)).toBe(true);
  });
});
