'use client';

import { useEffect, useRef, useState } from 'react';
import { parseStudentQr, type ApiResponse, type PhoneScanReply, type StudentQrData } from '@calc-rental/shared';
import { decodeFrame, decodePhoto } from './qr-decode';

const isSchoolId = (text: string) => parseStudentQr(text).ok;
const NOT_AN_ID = 'That QR code is not a school ID. Scan the QR on your ID card.';

type Scanned = { raw: string; student: StudentQrData };

export function ScanClient() {
  const [scanned, setScanned] = useState<Scanned | null>(null);
  const [camera, setCamera] = useState(false);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function accept(raw: string) {
    const parsed = parseStudentQr(raw);
    if (!parsed.ok) return setProblem(NOT_AN_ID);
    setScanned({ raw, student: parsed.data });
    setCamera(false);
    setProblem(null);
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setReading(true);
    setProblem(null);
    try {
      const result = await decodePhoto(file, isSchoolId);
      if (result.text) accept(result.text);
      else setProblem(result.sawOtherQr ? NOT_AN_ID : 'No QR code found. Get closer so the QR fills more of the photo, keep it sharp, and avoid glare.');
    } catch {
      setProblem('Could not open that picture. Try taking a new photo.');
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function send() {
    if (!scanned) return;
    setSending(true);
    setProblem(null);
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, qr: scanned.raw }),
      });
      const body = (await res.json()) as ApiResponse<PhoneScanReply>;
      if (body.success) setSentTo(body.data.fullName);
      else setProblem(body.error.message);
    } catch {
      setProblem('No connection. Check your internet and try again.');
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    setScanned(null);
    setCode('');
    setSentTo(null);
    setProblem(null);
  }

  if (sentTo) {
    return (
      <section className="pt-10 text-center">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-green-600 text-3xl text-white" aria-hidden>
          ✓
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Sent!</h1>
        <p className="mt-2 text-slate-700">
          Hi <span className="font-semibold">{sentTo}</span>. Now look at the <b>kiosk screen</b> and follow it.
        </p>
        <p className="mt-1 text-sm text-slate-600">Borrowing? Choose your locker with the BLUE button.</p>
        <button type="button" onClick={startOver} className={`${secondaryButton} mt-8`}>
          Scan for another rental
        </button>
      </section>
    );
  }

  const codeOk = /^[0-9]{6}$/.test(code);

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Scan your school ID</h1>
        <p className="mt-1 text-sm text-slate-600">For the calculator rental kiosk.</p>
      </header>

      <Step n={1} title="Scan the QR on your ID">
        {scanned ? (
          <div className="rounded-lg border border-green-300 bg-green-50 p-3">
            <p className="font-semibold text-slate-900">{scanned.student.fullName}</p>
            <p className="text-sm text-slate-700">
              {scanned.student.studentNumber} · {scanned.student.courseProgram}
            </p>
            <button type="button" onClick={() => setScanned(null)} className="mt-2 text-sm font-medium text-blue-700 underline underline-offset-2">
              Not you? Scan again
            </button>
          </div>
        ) : camera ? (
          <LiveCamera onFound={accept} onClose={() => setCamera(false)} onFail={(m) => { setCamera(false); setProblem(m); }} />
        ) : (
          <div className="grid gap-2">
            <button type="button" onClick={() => { setProblem(null); setCamera(true); }} className={primaryButton} disabled={reading}>
              Use camera
            </button>
            <button type="button" onClick={() => fileInput.current?.click()} className={secondaryButton} disabled={reading}>
              {reading ? 'Reading the photo…' : 'Take or upload a photo'}
            </button>
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
          </div>
        )}
      </Step>

      <Step n={2} title="Type the code on the kiosk screen">
        <p className="mb-2 text-sm text-slate-600">No code yet? Press any button on the kiosk.</p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          aria-label="6-digit kiosk code"
          className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-center font-mono text-3xl tracking-[0.4em] text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
        />
      </Step>

      {problem && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {problem}
        </p>
      )}

      <button type="button" onClick={send} disabled={!scanned || !codeOk || sending} className={`${primaryButton} w-full`}>
        {sending ? 'Sending…' : 'Send to kiosk'}
      </button>

      <p className="mt-6 text-center text-xs text-slate-500">
        Your photo stays on your phone. Only the text in the QR (name, student number, course) is sent.
      </p>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-700 text-xs text-white">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function LiveCamera({ onFound, onClose, onFail }: { onFound: (raw: string) => void; onClose: () => void; onFail: (m: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [torch, setTorch] = useState<boolean | null>(null); // null = phone has no torch control
  const [hint, setHint] = useState('Hold the ID QR inside the frame');
  const track = useRef<MediaStreamTrack | null>(null);
  const callbacks = useRef({ onFound, onFail });
  callbacks.current = { onFound, onFail };

  useEffect(() => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      callbacks.current.onFail('The live camera needs a secure (https) link. Use "Take or upload a photo" instead.');
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | undefined;

    const tick = async () => {
      if (stopped || !video.current) return;
      const result = await decodeFrame(video.current, isSchoolId).catch(() => null);
      if (stopped) return;
      if (result?.text) return callbacks.current.onFound(result.text);
      if (result?.sawOtherQr) setHint('That QR is not a school ID');
      timer = setTimeout(tick, 150);
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (stopped || !video.current) return s.getTracks().forEach((t) => t.stop());
        video.current.srcObject = s;
        await video.current.play();
        track.current = s.getVideoTracks()[0] ?? null;
        const caps = track.current?.getCapabilities?.() as { torch?: boolean } | undefined;
        if (caps?.torch) setTorch(false);
        tick();
      })
      .catch(() => callbacks.current.onFail('Camera blocked. Allow camera access, or use "Take or upload a photo".'));

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function toggleTorch() {
    const on = !torch;
    try {
      await track.current?.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch(on);
    } catch {
      setTorch(null);
    }
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video ref={video} playsInline muted className="aspect-[3/4] w-full object-cover" />
        <div className="pointer-events-none absolute inset-[18%] rounded-xl border-4 border-white/80" aria-hidden />
        <p className="absolute inset-x-0 bottom-0 bg-black/50 p-2 text-center text-sm text-white">{hint}</p>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={onClose} className={secondaryButton}>
          Cancel
        </button>
        <button type="button" onClick={toggleTorch} disabled={torch === null} className={secondaryButton}>
          {torch ? 'Light off' : 'Light on'}
        </button>
      </div>
    </div>
  );
}

const buttonBase =
  'rounded-lg px-4 py-3 font-semibold transition-transform duration-100 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100';
const primaryButton = `${buttonBase} bg-blue-700 text-white hover:bg-blue-800`;
const secondaryButton = `${buttonBase} border border-slate-300 bg-white text-slate-900 hover:bg-slate-50`;
