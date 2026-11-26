'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type Status = 'connecting' | 'live' | 'paused';

/**
 * Keeps a server-rendered page up to date without a full reload:
 * - Local Raspberry Pi mode: polls `/api/local/live` every 2.5 s while visible.
 * - Online Supabase mode: subscribes to Supabase Realtime changes on `tables`.
 */
export function LiveRefresh({ tables }: { tables: readonly string[] }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('connecting');
  const key = tables.join(',');
  const local = isLocalBackend();

  useEffect(() => {
    if (local) {
      let cancelled = false;
      let lastToken: string | null = null;

      const poll = async () => {
        if (cancelled || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
        try {
          const res = await fetch('/api/local/live', { cache: 'no-store' });
          if (!res.ok) {
            if (!cancelled) setStatus('paused');
            return;
          }
          const data = (await res.json()) as { token?: string };
          if (cancelled) return;
          setStatus('live');
          if (lastToken !== null && data.token && data.token !== lastToken) {
            router.refresh();
          }
          if (data.token) lastToken = data.token;
        } catch {
          if (!cancelled) setStatus('paused');
        }
      };

      void poll();
      const interval = setInterval(() => void poll(), 2500);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }

    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 500);
    };

    const channel = supabase.channel(`live:${key}`);
    for (const table of key.split(',')) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh);
    }
    channel.subscribe((state) => {
      if (state === 'SUBSCRIBED') setStatus('live');
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') setStatus('paused');
    });

    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [key, local, router]);

  const label = { connecting: 'Connecting…', live: local ? 'Live (Local)' : 'Live', paused: 'Live updates paused' }[status];
  const dot = { connecting: 'bg-slate-400', live: 'bg-emerald-500', paused: 'bg-amber-500' }[status];

  return (
    <span
      role="status"
      title={status === 'paused' ? 'Refresh the page to reconnect' : 'Updates appear automatically'}
      className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600"
    >
      <span className="relative flex h-2 w-2">
        {status === 'live' && (
          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {label}
    </span>
  );
}
