import { describe, expect, it } from 'vitest';
import { Prbs, bitOf, bitString, originOf, tagOf } from './bits';
import { E1Framer, FAS_PATTERN, analyzeE1, crc4, findE1Alignment } from './e1';
import { alawToLinear, compressA, compressMu, linearToAlaw, linearToUlaw, pcmSineTest, ulawToLinear, uniformSnrDb } from './pcm';
import {
  amiDecode,
  amiEncode,
  b8zsDecode,
  b8zsEncode,
  hdb3Decode,
  hdb3Encode,
  longestZeroRun,
  runningDisparity,
  type Hdb3Marks,
} from './linecode';

describe('PCM (G.711)', () => {
  it('encodes silence and known A-law codes', () => {
    expect(linearToAlaw(0)).toBe(0xd5);
    expect(alawToLinear(0xd5)).toBe(8);
    expect(linearToAlaw(32767)).toBe(0xaa);
    expect(linearToAlaw(-32768)).toBe(0x2a);
  });
  it('encodes known mu-law codes', () => {
    expect(linearToUlaw(0)).toBe(0xff);
    expect(ulawToLinear(0xff)).toBe(0);
    expect(linearToUlaw(32767)).toBe(0x80);
    expect(linearToUlaw(-32768)).toBe(0x00);
  });
  it('round-trips within one quantisation step of the segment', () => {
    for (let x = -32000; x <= 32000; x += 97) {
      const y = alawToLinear(linearToAlaw(x));
      const seg = Math.max(16, Math.abs(x) / 16);
      expect(Math.abs(x - y)).toBeLessThanOrEqual(seg);
      const z = ulawToLinear(linearToUlaw(x));
      expect(Math.abs(x - z)).toBeLessThanOrEqual(seg + 8);
    }
  });
  it('is monotonic', () => {
    let prev = -Infinity;
    for (let x = -32768; x <= 32767; x += 13) {
      const y = alawToLinear(linearToAlaw(x));
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
  it('companding keeps a quiet signal well above the uniform 8-bit limit', () => {
    const loud = pcmSineTest(20000, 1000, 'A').snrDb;
    const quiet = pcmSineTest(200, 1000, 'A').snrDb;
    expect(loud).toBeGreaterThan(30);
    // an 8-bit uniform quantiser would give about 6.02*8+1.76-40 = 9.9 dB for this signal
    expect(quiet).toBeGreaterThan(uniformSnrDb(8) - 40 + 10);
  });
  it('compression curves are odd, normalised and continuous at 1/A', () => {
    expect(compressA(1)).toBeCloseTo(1, 12);
    expect(compressMu(1)).toBeCloseTo(1, 12);
    expect(compressA(-0.3)).toBeCloseTo(-compressA(0.3), 12);
    const a = 87.6;
    expect(compressA(1 / a - 1e-9)).toBeCloseTo(compressA(1 / a + 1e-9), 6);
  });
  it('uniform SNR rule: 49.9 dB for 8 bits', () => {
    expect(uniformSnrDb(8)).toBeCloseTo(49.92, 2);
  });
});

describe('PRBS', () => {
  it('PRBS9 has period 511 and 256 ones', () => {
    const p = new Prbs(9, 1);
    const first = Array.from({ length: 511 }, () => p.next());
    const second = Array.from({ length: 511 }, () => p.next());
    expect(second).toEqual(first);
    expect(first.reduce((a, b) => a + b, 0)).toBe(256);
  });
  it('PRBS15 has period 32767', () => {
    const p = new Prbs(15, 1);
    const seen = Array.from({ length: 32767 }, () => p.next());
    const again = Array.from({ length: 64 }, () => p.next());
    expect(again).toEqual(seen.slice(0, 64));
  });
});

describe('E1 framing (G.704)', () => {
  const frames = (n: number, cfg = { crc4: true, cas: false }) => {
    const fr = new E1Framer(cfg);
    const bits: number[] = [];
    for (let i = 0; i < n; i++) bits.push(...fr.nextFrame((ch) => ch).bits);
    return bits;
  };

  it('every frame is 256 bits and carries the FAS in even frames', () => {
    const bits = frames(4);
    expect(bits.length).toBe(1024);
    expect(bitString(bits, 1, 8)).toBe(FAS_PATTERN.join(''));
    expect(bits[256 + 1]).toBe(1); // NFAS bit 2 fixed to 1
  });

  it('the rate is 256 bits x 8000 frames = 2.048 Mbit/s with 93.75 % useful', () => {
    expect(256 * 8000).toBe(2_048_000);
    expect((30 / 32) * 100).toBe(93.75);
  });

  it('CRC-4 multiframe carries 001011 and the C bits of the previous submultiframe', () => {
    const bits = frames(16);
    const si = [1, 3, 5, 7, 9, 11].map((f) => bits[f * 256]);
    expect(si.join('')).toBe('001011');
    const first = bits.slice(0, 2048);
    for (let f = 0; f < 8; f += 2) first[f * 256] = 0;
    const calc = crc4(first);
    const rx = [8, 10, 12, 14].map((f) => bits[f * 256]!).reduce((a, b) => (a << 1) | b, 0);
    expect(rx).toBe(calc);
  });

  it('crc4 is a polynomial remainder: a codeword followed by its CRC has remainder 0', () => {
    const msg = Array.from({ length: 64 }, (_, i) => ((i * 7 + 3) % 5 === 0 ? 1 : 0));
    const c = crc4(msg);
    const withCrc = [...msg, (c >> 3) & 1, (c >> 2) & 1, (c >> 1) & 1, c & 1];
    expect(crc4(withCrc)).toBe(0);
  });

  it('finds alignment at any offset and reports a clean link', () => {
    const bits = frames(160);
    const shifted = [1, 0, 1, 1, 0, 0, 1, 0, 1, ...bits];
    expect(findE1Alignment(shifted)).toBe(9);
    const a = analyzeE1(shifted);
    expect(a.lof).toBe(false);
    expect(a.fasErrors).toBe(0);
    expect(a.multiframeOffset).toBeGreaterThanOrEqual(0);
    expect(a.crcBlocks).toBeGreaterThan(10);
    expect(a.crcErrors).toBe(0);
    expect(a.rai).toBe(false);
  });

  it('a single flipped payload bit is caught by CRC-4 in exactly one block', () => {
    const bits = frames(64);
    bits[256 * 20 + 80] ^= 1;
    const a = analyzeE1(bits);
    expect(a.crcErrors).toBe(1);
    expect(a.fasErrors).toBe(0);
  });

  it('raises RAI when the framer sets bit A', () => {
    const fr = new E1Framer({ crc4: true, cas: false, rai: true });
    const bits: number[] = [];
    for (let i = 0; i < 64; i++) bits.push(...fr.nextFrame(() => 0).bits);
    expect(analyzeE1(bits).rai).toBe(true);
  });

  it('CAS: TS16 of frame 0 is the multiframe alignment word and the others carry ABCD pairs', () => {
    const fr = new E1Framer({ crc4: false, cas: true });
    const f0 = fr.nextFrame(() => 0).bits;
    expect(bitString(f0, 128, 136)).toBe('00001011');
    const f1 = fr.nextFrame(() => 0).bits;
    expect(bitString(f1, 128, 136)).toBe('11011101');
  });

  it('loses frame alignment when the FAS is destroyed', () => {
    const bits = frames(64, { crc4: false, cas: false });
    for (let f = 10; f < 40; f += 2) for (let i = 1; i < 8; i++) bits[f * 256 + i] ^= 1;
    expect(analyzeE1(bits).lof).toBe(true);
  });

  it('E bits report the CRC result back to the sender', () => {
    const fr = new E1Framer({ crc4: true, cas: false, eBits: [0, 1] });
    const bits: number[] = [];
    for (let i = 0; i < 64; i++) bits.push(...fr.nextFrame(() => 0).bits);
    expect(analyzeE1(bits).febe).toBe(4);
  });
});

describe('line codes (G.703)', () => {
  const bitsOf = (s: string) => Array.from(s, Number);

  it('AMI alternates the polarity of the ones', () => {
    const p = amiEncode(bitsOf('1011001'));
    expect(p).toEqual([1, 0, -1, 1, 0, 0, -1]);
    expect(amiDecode(p)).toEqual(bitsOf('1011001'));
  });

  it('AMI cannot keep the clock on a long run of zeros, HDB3 can', () => {
    const zeros = Array(40).fill(0);
    expect(longestZeroRun(amiEncode(zeros))).toBe(40);
    expect(longestZeroRun(hdb3Encode(zeros))).toBeLessThanOrEqual(3);
  });

  it('HDB3 slide example 1 0 0 0 0 1 0 1', () => {
    const marks: Hdb3Marks = { violations: [], fillers: [] };
    const p = hdb3Encode(bitsOf('10000101'), marks);
    // one pulse since the start (odd) -> 000V with V repeating the polarity of the last pulse
    expect(p).toEqual([1, 0, 0, 0, 1, -1, 0, 1]);
    expect(marks.violations).toEqual([4]);
    expect(hdb3Decode(p)).toEqual(bitsOf('10000101'));
  });

  it('HDB3 uses B00V when an even number of pulses precede the zeros', () => {
    const p = hdb3Encode(bitsOf('1100001'));
    expect(p).toEqual([1, -1, 1, 0, 0, 1, -1]);
    expect(hdb3Decode(p)).toEqual(bitsOf('1100001'));
  });

  it('HDB3 round-trips random data and keeps the DC bounded', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 50; trial++) {
      const bits = Array.from({ length: 600 }, () => (rnd() < 0.3 ? 1 : 0));
      for (let i = 100; i < 140; i++) bits[i] = 0;
      const p = hdb3Encode(bits);
      expect(hdb3Decode(p)).toEqual(bits);
      expect(longestZeroRun(p)).toBeLessThanOrEqual(3);
      const d = runningDisparity(p);
      expect(d.max).toBeLessThanOrEqual(2);
      expect(d.min).toBeGreaterThanOrEqual(-2);
    }
  });

  it('B8ZS replaces eight zeros with 000VB0VB and decodes back', () => {
    const bits = bitsOf('10000000001');
    const p = b8zsEncode(bits);
    expect(p.slice(1, 9)).toEqual([0, 0, 0, 1, -1, 0, -1, 1]);
    expect(b8zsDecode(p)).toEqual(bits);
    expect(longestZeroRun(p)).toBeLessThanOrEqual(7);
  });

  it('origin tags decode to E1, frame, time slot and bit', () => {
    const o = originOf(tagOf(2 * (1 + 3 * 256 + 2 * 8 + 1 + 5 * 2 ** 26) + 1));
    expect(o).toMatchObject({ src: 5, frame: 3, ts: 2, bitInTs: 2 });
    expect(bitOf(2 * 77 + 1)).toBe(1);
  });
});
