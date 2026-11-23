import { Wifi } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { LanShareSnapshot } from '@/types/domain';

export function LanShareIndicator({
  snapshot,
  onClick,
  variant = 'toolbar',
}: {
  snapshot: LanShareSnapshot;
  onClick: () => void;
  variant?: 'toolbar' | 'floating';
}) {
  if (snapshot.status.state === 'off') return null;

  let label = 'Sharing';
  let statusDescription = 'Listening for pairing';
  let dotClass = 'bg-emerald-600 dark:bg-emerald-400';

  if (snapshot.status.state === 'paired') {
    label = 'Sharing · Connected';
    statusDescription = `Connected to ${snapshot.status.peerIp}`;
  } else if (snapshot.status.state === 'codeLocked') {
    label = 'Sharing · Code locked';
    statusDescription = 'Code locked after failed attempts — open to regenerate';
    dotClass = 'bg-amber-600 dark:bg-amber-400';
  }

  const isFloating = variant === 'floating';

  return (
    <button
      type="button"
      data-testid={isFloating ? 'lan-share-floating-indicator' : 'lan-share-indicator'}
      data-share-state={snapshot.status.state}
      aria-label={`LAN sharing active: ${statusDescription}. Click to open sharing window.`}
      title={snapshot.address ? `${statusDescription} (${snapshot.address})` : statusDescription}
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        snapshot.status.state === 'codeLocked'
          ? 'border-amber-600/40 bg-amber-500/15 text-amber-900 hover:bg-amber-500/25 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-100'
          : 'border-emerald-600/35 bg-emerald-500/10 text-emerald-900 hover:bg-emerald-500/20 dark:border-emerald-400/40 dark:bg-emerald-500/20 dark:text-emerald-100',
        isFloating
          ? 'fixed right-4 bottom-4 z-50 bg-background/95 px-3 py-1.5 shadow-md backdrop-blur-sm'
          : 'h-7 px-2.5 py-0.5',
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dotClass)} aria-hidden="true" />
      <Wifi className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
