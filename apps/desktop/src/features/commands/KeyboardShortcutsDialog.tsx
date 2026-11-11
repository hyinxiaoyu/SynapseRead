import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@/components/ui/button';
import { commandDefinition, formatShortcut, MENUS } from '@/features/commands/commands';

/** Help ▸ Keyboard Shortcuts: every command with a key, grouped as in the menu bar. */
export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    // Capture: the dialog closes before anything under it sees the key.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex animate-in items-center justify-center bg-black/30 p-6 duration-150 fade-in-0 motion-reduce:animate-none"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        data-reader-popover=""
        data-testid="keyboard-shortcuts-dialog"
        className="flex max-h-full w-full max-w-2xl animate-in flex-col rounded-lg border bg-background text-foreground shadow-xl duration-150 fade-in-0 zoom-in-95 motion-reduce:animate-none"
      >
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 id="keyboard-shortcuts-title" className="text-sm font-semibold">
            Keyboard Shortcuts
          </h2>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="grid gap-x-8 gap-y-4 overflow-y-auto p-4 text-xs sm:grid-cols-2">
          {MENUS.map((menu) => {
            const rows = menu.items
              .filter((item) => item !== 'separator')
              .map((id) => commandDefinition(id))
              .filter((definition) => definition.shortcut !== null);
            if (rows.length === 0) return null;
            return (
              <section key={menu.id} aria-label={menu.title}>
                <h3 className="mb-1 font-medium text-muted-foreground">{menu.title}</h3>
                <dl className="divide-y">
                  {rows.map((definition) => (
                    <div key={definition.id} className="flex justify-between gap-4 py-1">
                      <dt>{definition.title.replace(/…$/, '')}</dt>
                      <dd>
                        <kbd className="font-sans tabular-nums text-muted-foreground">
                          {formatShortcut(definition.shortcut ?? '')}
                        </kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
