import type { ComponentProps } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return (
    <Group data-slot="resizable-panel-group" className={cn('size-full', className)} {...props} />
  );
}

export const ResizablePanel = Panel;

export function ResizableHandle({ className, ...props }: ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        'w-px bg-border outline-none transition-colors hover:bg-ring focus-visible:bg-ring data-[separator=active]:bg-ring',
        className,
      )}
      {...props}
    />
  );
}
