import { isTauri } from '@tauri-apps/api/core';

import type { CommandId } from '@/features/commands/commands';
import {
  createMemoryBackendWithPreview,
  type MemoryLanTestController,
} from '@/lib/backend/memoryBackend';
import { createTauriBackend } from '@/lib/backend/tauriBackend';
import type { StudyBackend } from '@/lib/backend/types';

export interface SynapsePreviewController {
  chooseMenuCommand(commandId: CommandId): void;
  lan: MemoryLanTestController;
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
  const { backend, emitMenuCommand, lan } = createMemoryBackendWithPreview();
  if (typeof window !== 'undefined') {
    window.__synapsePreview = {
      chooseMenuCommand: emitMenuCommand,
      lan,
    };
  }
  return backend;
}

export type { StudyBackend };
