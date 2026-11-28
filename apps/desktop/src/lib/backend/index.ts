import { isTauri } from '@tauri-apps/api/core';

import type { CommandId } from '@/features/commands/commands';
import {
  createMemoryBackendWithPreview,
  type MemoryBackendWithPreview,
  type MemoryHostStats,
  type MemoryLanTestController,
  type MemoryMenuItemStateMap,
} from '@/lib/backend/memoryBackend';
import { createTauriBackend } from '@/lib/backend/tauriBackend';
import type { StudyBackend } from '@/lib/backend/types';

export interface SynapsePreviewController {
  chooseMenuCommand(commandId: CommandId): void;
  lan: MemoryLanTestController;
  getMenuItemStates(): MemoryMenuItemStateMap;
  getHostStats(): MemoryHostStats;
  listLocalBookmarks: MemoryBackendWithPreview['listLocalBookmarks'];
  getNodeLayoutWrites: MemoryBackendWithPreview['getNodeLayoutWrites'];
  pauseNextNodeLayoutWrite(): void;
  releasePausedNodeLayoutWrite(): void;
  hasPausedNodeLayoutWrite(): boolean;
  triggerBeforeClose: MemoryBackendWithPreview['triggerBeforeClose'];
  pauseNextCursorWrite(): void;
  releasePausedCursorWrite(): void;
}

declare global {
  interface Window {
    __synapsePreview?: SynapsePreviewController;
  }
}

export function createDefaultBackend(): StudyBackend {
  if (isTauri()) {
    return createTauriBackend();
  }
  const preview = createMemoryBackendWithPreview();
  if (typeof window !== 'undefined') {
    window.__synapsePreview = {
      chooseMenuCommand: preview.emitMenuCommand,
      lan: preview.lan,
      getMenuItemStates: preview.getMenuItemStates,
      getHostStats: preview.getHostStats,
      listLocalBookmarks: preview.listLocalBookmarks,
      getNodeLayoutWrites: preview.getNodeLayoutWrites,
      pauseNextNodeLayoutWrite: preview.pauseNextNodeLayoutWrite,
      releasePausedNodeLayoutWrite: preview.releasePausedNodeLayoutWrite,
      hasPausedNodeLayoutWrite: preview.hasPausedNodeLayoutWrite,
      triggerBeforeClose: preview.triggerBeforeClose,
      pauseNextCursorWrite: preview.pauseNextCursorWrite,
      releasePausedCursorWrite: preview.releasePausedCursorWrite,
    };
  }
  return preview.backend;
}

export type { StudyBackend };
