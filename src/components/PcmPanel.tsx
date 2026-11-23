import { useMemo, useState } from 'react';
import { A_LAW, compressA, compressMu, MU_LAW, pcmSineTest, uniformSnrDb } from '../core/pcm';
import { useI18n } from '../i18n';
import { Card, Legend, LineChart, Segmented, Slider, Stat } from './ui';

export function PcmPanel() {
  const { tr, num } = useI18n();
  const [law, setLaw] = useState<'A' | 'mu'>('A');
  const [amp, setAmp] = useState(2000);

  const curves = useMemo(() => {
    const pts = (f: (x: number) => number): [number, number][] => Array.from({ length: 101 }, (_, i) => [i / 100, f(i / 100)]);
    return [
      { name: tr('Lineal (sin compansión)', 'Linear (no companding)'), color: 'var(--muted)', points: pts((x) => x), dashed: true },
      { name: `A = ${A_LAW}`, color: 'var(--accent)', points: pts((x) => compressA(x)) },
      { name: `µ = ${MU_LAW}`, color: 'var(--warn)', points: pts((x) => compressMu(x)) },
    ];
  }, [tr]);

  const snr = useMemo(() => {
    const levels = Array.from({ length: 28 }, (_, i) => 10 ** (1 + i * 0.12)); // amplitudes 10 .. ~20000
    const pts = (l: 'A' | 'mu'): [number, number][] =>
      levels.filter((a) => a <= 32000).map((a) => [20 * Math.log10(a / 32768), pcmSineTest(a, 997, l, 1600).snrDb]);
    const uniform: [number, number][] = levels
      .filter((a) => a <= 32000)
      .map((a) => [20 * Math.log10(a / 32768), uniformSnrDb(8) + 20 * Math.log10(a / 32768)]);
    return [
      { name: tr('Uniforme de 8 bits', 'Uniform 8-bit'), color: 'var(--muted)', points: uniform, dashed: true },
      { name: tr('Ley A', 'A-law'), color: 'var(--accent)', points: pts('A') },
      { name: tr('Ley µ', 'µ-law'), color: 'var(--warn)', points: pts('mu') },
    ];
  }, [tr]);

  const test = useMemo(() => pcmSineTest(amp, 1000, law, 64), [amp, law]);

  return (
    <div className="stack">
      <Card title={tr('PCM · el canal DS0 de 64 kbit/s', 'PCM · the 64 kbit/s DS0 channel')}>
        <div className="two-col">
          <div>
            <Legend items={curves} />
            <LineChart
              ariaLabel={tr('Curvas de compresión de ley A y ley µ', 'A-law and µ-law compression curves')}
              series={curves}
              xDomain={[0, 1]}
              yDomain={[0, 1]}
              xLabel={tr('entrada normalizada |x|', 'normalised input |x|')}
              yLabel="F(x)"
              width={620}
              height={270}
            />
            <p className="hint">
              {tr(
                'Se comprime antes de cuantificar: las señales débiles ocupan más niveles. G.711 usa 13 segmentos (ley A) o 15 (ley µ).',
                'The signal is compressed before quantising: weak signals get more levels. G.711 uses 13 segments (A-law) or 15 (µ-law).',
              )}
            </p>
          </div>
          <div>
            <Legend items={snr} />
            <LineChart
              ariaLabel={tr('Relación señal a ruido contra nivel de entrada', 'Signal to noise ratio against input level')}
              series={snr}
              xLabel={tr('nivel de entrada (dB respecto a plena escala)', 'input level (dB re full scale)')}
              yLabel="SNR (dB)"
              width={620}
              height={270}
              yDomain={[0, 50]}
            />
            <p className="hint">
              {tr(
                'Medido sobre una senoidal de 997 Hz que pasa de verdad por el codificador. La compansión mantiene la SNR en unos 36 a 39 dB desde −40 hasta −5 dB de la plena escala, a costa de unos 8 dB frente al uniforme con señales fuertes; el cuantificador uniforme pierde 1 dB por cada dB que baja la señal.',
                'Measured on a real 997 Hz sine that goes through the encoder. Companding holds the SNR at about 36 to 39 dB from −40 to −5 dB below full scale, at the price of about 8 dB against the uniform quantiser on loud signals; the uniform quantiser loses 1 dB for every dB the signal drops.',
              )}
            </p>
          </div>
        </div>
      </Card>

      <Card title={tr('Una muestra, un byte', 'One sample, one byte')}>
        <div className="two-col">
          <div className="stack">
            <Segmented
              label={tr('Ley', 'Law')}
              value={law}
              onChange={setLaw}
              options={[
                { value: 'A', label: tr('Ley A (E1)', 'A-law (E1)') },
                { value: 'mu', label: tr('Ley µ (T1)', 'µ-law (T1)') },
              ]}
            />
            <Slider label={tr('Amplitud de la senoidal de 1 kHz', 'Amplitude of the 1 kHz sine')} value={amp} min={20} max={30000} step={20} onChange={setAmp} />
            <div className="stats-grid">
              <Stat label="SNR" value={`${num(test.snrDb, 1)} dB`} sub={tr('medida en 64 muestras', 'measured over 64 samples')} />
              <Stat label={tr('Tasa', 'Rate')} value="64 kbit/s" sub="8 000 × 8 bit" />
              <Stat label={tr('Periodo de muestreo', 'Sampling period')} value="125 µs" sub="Nyquist: 8 kHz > 2 × 3,4 kHz" />
            </div>
          </div>
          <div className="codes" aria-label={tr('Primeras ocho muestras codificadas', 'First eight encoded samples')}>
            {test.codes.slice(0, 8).map((c, i) => (
              <div key={i} className="code-row">
                <span className="hint">n={i}</span>
                <code>{c.toString(2).padStart(8, '0')}</code>
                <span>0x{c.toString(16).toUpperCase().padStart(2, '0')}</span>
                <span className="hint">→ {test.decoded[i]}</span>
              </div>
            ))}
            <p className="hint">
              {tr('Signo · segmento (3 bits) · nivel dentro del segmento (4 bits), con los bits pares invertidos como pide G.711.', 'Sign · segment (3 bits) · level inside the segment (4 bits), with the even bits inverted as G.711 requires.')}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
