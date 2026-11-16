'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

type Status = 'connecting' | 'live' | 'paused';

/**
 * Keeps a server-rendered page up to date (spec §23) without a full reload:
 * listens to Supabase Realtime changes on `tables` and re-renders the page
 * (router.refresh) at most every 500 ms. RLS applies to Realtime too, so
 * only active admins receive changes.
 */
export function LiveRefresh({ tables }: { tables: readonly string[] }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('connecting');
  const key = tables.join(',');

  useEffect(() => {
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
  }, [key, router]);

  const label = { connecting: 'Connecting…', live: 'Live', paused: 'Live updates paused' }[status];
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
