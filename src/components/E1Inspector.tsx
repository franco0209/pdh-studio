import { useMemo, useState } from 'react';
import { bitString, Prbs } from '../core/bits';
import { analyzeE1, crc4, E1Framer, E1_FRAME_BITS, FAS_PATTERN } from '../core/e1';
import { amiEncode, hdb3Encode, longestZeroRun, runningDisparity, type Hdb3Marks } from '../core/linecode';
import { alawToLinear, linearToAlaw } from '../core/pcm';
import { useI18n } from '../i18n';
import { Badge, Card, Segmented, Stat, Toggle } from './ui';
import { Waveform } from './Waveform';

type Content = 'tone' | 'prbs' | 'idle' | 'zeros';

function buildFrames(n: number, o: { crc4: boolean; cas: boolean; rai: boolean; content: Content }): Uint8Array[] {
  const fr = new E1Framer({ crc4: o.crc4, cas: o.cas, rai: o.rai });
  const prbs = new Prbs(15, 77);
  const out: Uint8Array[] = [];
  for (let k = 0; k < n; k++) {
    out.push(
      fr.nextFrame((ch) => {
        if (o.content === 'zeros') return 0;
        if (o.content === 'idle') return 0xd5;
        if (o.content === 'prbs') {
          let b = 0;
          for (let i = 0; i < 8; i++) b = (b << 1) | prbs.next();
          return b;
        }
        return linearToAlaw(9000 * Math.sin((2 * Math.PI * (300 + ch * 55) * k) / 8000 + ch));
      }).bits,
    );
  }
  return out;
}

const tsRole = (ts: number): 'sync' | 'sig' | 'voice' => (ts === 0 ? 'sync' : ts === 16 ? 'sig' : 'voice');

export function E1Inspector() {
  const { tr, num } = useI18n();
  const [useCrc, setUseCrc] = useState(true);
  const [cas, setCas] = useState(false);
  const [rai, setRai] = useState(false);
  const [content, setContent] = useState<Content>('tone');
  const [frame, setFrame] = useState(1);
  const [ts, setTs] = useState(0);
  const [code, setCode] = useState<'ami' | 'hdb3'>('hdb3');
  const [flips, setFlips] = useState<number[]>([]);
  const [killFas, setKillFas] = useState(false);

  const frames = useMemo(() => buildFrames(96, { crc4: useCrc, cas, rai, content }), [useCrc, cas, rai, content]);

  const stream = useMemo(() => {
    const bits = new Uint8Array(frames.length * E1_FRAME_BITS);
    frames.forEach((f, i) => bits.set(f, i * E1_FRAME_BITS));
    for (const p of flips) bits[p] ^= 1;
    if (killFas) for (let f = 10; f < 80; f += 2) for (let i = 1; i < 8; i++) bits[f * E1_FRAME_BITS + i] ^= 1;
    return bits;
  }, [frames, flips, killFas]);

  const analysis = useMemo(() => analyzeE1(stream), [stream]);
  const cur = frames[frame % frames.length]!;
  const fm = frame % 16;

  const byteAt = (f: Uint8Array, t: number) => {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | f[t * 8 + i]!;
    return v;
  };

  // line coding of the selected time slot and its neighbours
  const wave = useMemo(() => {
    const from = Math.max(0, ts * 8 - 8);
    const to = Math.min(E1_FRAME_BITS, ts * 8 + 16);
    const bits = Array.from(cur.slice(from, to));
    const marks: Hdb3Marks = { violations: [], fillers: [] };
    const pulses = code === 'ami' ? amiEncode(bits) : hdb3Encode(bits, marks);
    return { bits, pulses, marks, from };
  }, [cur, ts, code]);

  const longRun = useMemo(() => {
    const all = Array.from(stream.slice(0, 32 * E1_FRAME_BITS));
    return {
      ami: longestZeroRun(amiEncode(all)),
      hdb3: longestZeroRun(hdb3Encode(all)),
      dcAmi: runningDisparity(amiEncode(all)),
      dcHdb3: runningDisparity(hdb3Encode(all)),
    };
  }, [stream]);

  const sel = byteAt(cur, ts);
  const crcInfo = useMemo(() => {
    if (!useCrc) return null;
    const base = Math.floor(fm / 8) * 8;
    // CRC-4 that the frames of this submultiframe carry belongs to the previous submultiframe
    const prevStart = (Math.floor(frame / 8) - 1) * 8;
    if (prevStart < 0) return null;
    const calc: number[] = [];
    for (let f = 0; f < 8; f++) {
      const fr = frames[prevStart + f]!;
      for (let i = 0; i < E1_FRAME_BITS; i++) calc.push(i === 0 && f % 2 === 0 ? 0 : fr[i]!);
    }
    const mine = frames[(Math.floor(frame / 8)) * 8]!;
    void base;
    const rx = [0, 2, 4, 6].map((k) => frames[Math.floor(frame / 8) * 8 + k]![0]!).reduce((a, b) => (a << 1) | b, 0);
    void mine;
    return { calc: crc4(calc), rx };
  }, [useCrc, frame, frames, fm]);

  const flipSomething = () => {
    const pos = (20 + flips.length * 7) * E1_FRAME_BITS + 8 * (3 + flips.length) + 4;
    setFlips([...flips, pos]);
  };

  return (
    <div className="stack">
      <Card
        title={tr('Trama E1 · G.704 / G.732', 'E1 frame · G.704 / G.732')}
        aside={
          <div className="row">
            <Toggle label="CRC-4" checked={useCrc} onChange={setUseCrc} />
            <Toggle label={tr('CAS (TS16)', 'CAS (TS16)')} checked={cas} onChange={setCas} />
            <Toggle label={tr('Enviar RAI', 'Send RAI')} checked={rai} onChange={setRai} />
          </div>
        }
      >
        <div className="row spread">
          <Segmented
            label={tr('Contenido', 'Content')}
            value={content}
            onChange={setContent}
            options={[
              { value: 'tone', label: tr('Voz', 'Voice') },
              { value: 'prbs', label: 'PRBS-15' },
              { value: 'idle', label: tr('Silencio', 'Idle') },
              { value: 'zeros', label: tr('Todo ceros', 'All zeros') },
            ]}
          />
          <div className="frame-nav compact">
            <label htmlFor="fno">{tr('Trama', 'Frame')}</label>
            <input id="fno" type="range" min={0} max={frames.length - 1} value={frame} onChange={(e) => setFrame(Number(e.target.value))} />
            <output>
              {frame} · {tr('multitrama', 'multiframe')} {fm}/16
            </output>
          </div>
        </div>

        <div className="ts-grid" role="group" aria-label={tr('32 intervalos de tiempo', '32 time slots')}>
          {Array.from({ length: 32 }, (_, t) => {
            const b = byteAt(cur, t);
            const role = tsRole(t);
            return (
              <button key={t} type="button" className={`ts ts-${role} ${t === ts ? 'ts-sel' : ''}`} aria-pressed={t === ts} onClick={() => setTs(t)}>
                <span className="ts-n">TS{t}</span>
                <code>{b.toString(2).padStart(8, '0')}</code>
                <span className="ts-h">{b.toString(16).toUpperCase().padStart(2, '0')}</span>
              </button>
            );
          })}
        </div>
        <p className="hint">
          {tr(
            '256 bits cada 125 µs = 2 048 kbit/s. TS0 sincronismo, TS16 señalización, 30 canales de 64 kbit/s: 30/32 = 93,75 % útil.',
            '256 bits every 125 µs = 2 048 kbit/s. TS0 is sync, TS16 signalling, 30 channels of 64 kbit/s: 30/32 = 93.75 % useful.',
          )}
        </p>

        <div className="two-col">
          <div className="decode">
            <h3>TS{ts}</h3>
            {ts === 0 ? (
              <>
                <p>
                  {frame % 2 === 0 ? (
                    <>
                      {tr('Trama par: ', 'Even frame: ')}
                      <code>
                        Si {cur[0]} · {bitString(cur, 1, 8)}
                      </code>{' '}
                      — {tr('FAS esperada', 'expected FAS')} <code>{FAS_PATTERN.join('')}</code> {tr('en los bits 2 a 8', 'in bits 2 to 8')}.
                    </>
                  ) : (
                    <>
                      {tr('Trama impar: ', 'Odd frame: ')}
                      <code>
                        Si {cur[0]} · 1 · A={cur[2]} · Sa4–Sa8 {bitString(cur, 3, 8)}
                      </code>
                      . {tr('El bit 2 fijo en 1 evita imitar la FAS; A = 1 avisa del fallo al otro extremo (RAI).', 'Fixed bit 2 = 1 avoids imitating the FAS; A = 1 reports the failure to the far end (RAI).')}
                    </>
                  )}
                </p>
                {useCrc && (
                  <p className="hint">
                    {tr('Con CRC-4 el bit Si de las tramas pares lleva C1–C4 y el de las impares la palabra 001011 y los bits E.', 'With CRC-4 the Si bit of even frames carries C1–C4 and that of odd frames the 001011 word and the E bits.')}
                  </p>
                )}
              </>
            ) : ts === 16 ? (
              cas ? (
                <p>
                  {fm === 0
                    ? tr('Trama 0 de la multitrama: 0000 X Y X X. Alineación de multitrama (MAS); Y = alarma de multitrama remota.', 'Frame 0 of the multiframe: 0000 X Y X X. Multiframe alignment (MAS); Y = remote multiframe alarm.')
                    : tr(`Trama ${fm}: ABCD del canal ${fm} y ABCD del canal ${fm + 15}. 2 kbit/s por canal.`, `Frame ${fm}: ABCD of channel ${fm} and ABCD of channel ${fm + 15}. 2 kbit/s per channel.`)}
                </p>
              ) : (
                <p>{tr('CCS: un solo canal de 64 kbit/s (HDLC) señaliza a los 30 canales. Libre, repite el indicador 01111110.', 'CCS: one 64 kbit/s (HDLC) channel signals all 30 channels. When idle it repeats the 01111110 flag.')}</p>
              )
            ) : (
              <p>
                {tr(`Canal de voz ${ts < 16 ? ts : ts - 1}. Muestra A-law `, `Voice channel ${ts < 16 ? ts : ts - 1}. A-law sample `)}
                <code>0x{sel.toString(16).toUpperCase().padStart(2, '0')}</code> → {tr('lineal', 'linear')} <strong>{alawToLinear(sel)}</strong>
              </p>
            )}
            <h3>{tr('Código de línea', 'Line code')}</h3>
            <Segmented
              label={tr('Código de línea', 'Line code')}
              value={code}
              onChange={setCode}
              options={[
                { value: 'ami', label: 'AMI' },
                { value: 'hdb3', label: 'HDB3' },
              ]}
            />
          </div>
          <div>
            <Waveform
              bits={wave.bits}
              pulses={wave.pulses}
              violations={wave.marks.violations}
              fillers={wave.marks.fillers}
              label={tr(`Forma de onda de TS${ts} con ${code.toUpperCase()}`, `Waveform of TS${ts} with ${code.toUpperCase()}`)}
            />
            <div className="stats-grid">
              <Stat
                label={tr('Ceros seguidos · AMI', 'Zero run · AMI')}
                value={longRun.ami}
                tone={longRun.ami > 15 ? 'bad' : 'good'}
                sub={tr('el reloj se pierde si es muy largo', 'the clock is lost if too long')}
              />
              <Stat label={tr('Ceros seguidos · HDB3', 'Zero run · HDB3')} value={longRun.hdb3} tone="good" sub={tr('siempre ≤ 3', 'always ≤ 3')} />
              <Stat
                label={tr('Nivel DC (rango)', 'DC level (range)')}
                value={`${longRun.dcHdb3.min}…${longRun.dcHdb3.max}`}
                sub={tr('HDB3 mantiene la suma acotada', 'HDB3 keeps the running sum bounded')}
              />
            </div>
            <p className="hint">
              {tr('Prueba con «Todo ceros»: AMI se queda sin transiciones, HDB3 inserta violaciones (V) y rellenos (B).', 'Try “All zeros”: AMI has no transitions, HDB3 inserts violations (V) and fillers (B).')}
            </p>
          </div>
        </div>
      </Card>

      <Card
        title={tr('Detección de errores y alineación', 'Error detection and alignment')}
        aside={
          <div className="row">
            <button type="button" className="btn btn-small" onClick={flipSomething}>
              {tr('Voltear un bit de datos', 'Flip a payload bit')}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setKillFas(!killFas)} aria-pressed={killFas}>
              {killFas ? tr('Restaurar FAS', 'Restore FAS') : tr('Destruir la FAS', 'Destroy the FAS')}
            </button>
            <button type="button" className="btn btn-small" onClick={() => { setFlips([]); setKillFas(false); }} disabled={!flips.length && !killFas}>
              {tr('Limpiar', 'Clear')}
            </button>
          </div>
        }
      >
        <div className="stats-grid">
          <Stat
            label={tr('Alineación de trama', 'Frame alignment')}
            value={<Badge ok={!analysis.lof && analysis.offset >= 0}>{analysis.offset >= 0 && !analysis.lof ? tr('Sincronizado', 'In sync') : 'LOF'}</Badge>}
            sub={tr(`errores de FAS: ${analysis.fasErrors}`, `FAS errors: ${analysis.fasErrors}`)}
          />
          <Stat
            label={tr('Multitrama CRC-4', 'CRC-4 multiframe')}
            value={useCrc ? <Badge ok={analysis.multiframeOffset >= 0}>{analysis.multiframeOffset >= 0 ? tr('Alineada', 'Aligned') : tr('Perdida', 'Lost')}</Badge> : tr('desactivado', 'disabled')}
            sub={useCrc ? tr(`${analysis.crcBlocks} bloques de 2048 bits`, `${analysis.crcBlocks} blocks of 2048 bits`) : undefined}
          />
          <Stat
            label={tr('Bloques con error', 'Errored blocks')}
            value={useCrc ? analysis.crcErrors : '—'}
            tone={analysis.crcErrors ? 'bad' : 'good'}
            sub={tr('el CRC-4 detecta, no corrige', 'CRC-4 detects, it does not correct')}
          />
          <Stat label="RAI" value={analysis.rai ? tr('recibido', 'received') : tr('no', 'no')} tone={analysis.rai ? 'warn' : undefined} sub={tr('bit A de TS0', 'bit A of TS0')} />
        </div>
        {crcInfo && (
          <p className="crc">
            {tr('CRC-4 de la submultitrama anterior: ', 'CRC-4 of the previous submultiframe: ')}
            <code>{crcInfo.calc.toString(2).padStart(4, '0')}</code> {tr('calculado', 'computed')} · <code>{crcInfo.rx.toString(2).padStart(4, '0')}</code> {tr('recibido en C1–C4', 'received in C1–C4')}{' '}
            <Badge ok={crcInfo.calc === crcInfo.rx}>{crcInfo.calc === crcInfo.rx ? tr('coincide', 'match') : tr('no coincide', 'mismatch')}</Badge>
          </p>
        )}
        <p className="hint">
          {tr(
            `Generador x⁴ + x + 1. Se calcula sobre 2048 bits (una submultitrama de 1 ms) y viaja en la siguiente; el extremo remoto contesta con los bits E. Se declara LOF tras 3 FAS erróneas seguidas (G.706). Tramas analizadas: ${num(analysis.frames, 0)}.`,
            `Generator x⁴ + x + 1. It is computed over 2048 bits (a 1 ms submultiframe) and travels in the next one; the far end answers with the E bits. LOF is declared after 3 consecutive wrong FAS (G.706). Frames analysed: ${num(analysis.frames, 0)}.`,
          )}
        </p>
      </Card>
    </div>
  );
}
