import { useEffect } from 'react';

import { commandDefinition, isCommandId } from '@/features/commands/commands';
import { commandStates, onCommandStatesChange, runCommand } from '@/features/commands/registry';
import type { MenuItemState } from '@/lib/backend/types';

/** Coalesces a burst of registrations (a tab switch) into one IPC call. */
const SYNC_DELAY_MS = 16;

/**
 * Connects the native menu to the command registry: a chosen item runs its
 * command, and items follow the registry's enabled state and context titles.
 */
export function useNativeMenu(
  onMenuCommand: (listener: (commandId: string) => void) => () => void,
  setMenuItemStates: (states: readonly MenuItemState[]) => Promise<void>,
) {
  useEffect(
    () =>
      onMenuCommand((commandId) => {
        if (isCommandId(commandId)) runCommand(commandId, 'menu');
      }),
    [onMenuCommand],
  );

  useEffect(() => {
    const sent = new Map<string, string>();
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const changed: MenuItemState[] = [];
        for (const state of commandStates()) {
          const key = `${state.enabled}:${state.title}`;
          if (sent.get(state.id) === key) continue;
          sent.set(state.id, key);
          const isDefaultTitle = state.title === commandDefinition(state.id).title;
          changed.push(
            isDefaultTitle
              ? { id: state.id, enabled: state.enabled }
              : { id: state.id, enabled: state.enabled, title: state.title },
          );
        }
        if (changed.length > 0) void setMenuItemStates(changed);
      }, SYNC_DELAY_MS);
    };
    sync();
    const unsubscribe = onCommandStatesChange(sync);
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [setMenuItemStates]);
}
