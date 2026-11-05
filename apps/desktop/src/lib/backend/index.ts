import { isTauri } from '@tauri-apps/api/core';

import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import { createTauriBackend } from '@/lib/backend/tauriBackend';
import type { StudyBackend } from '@/lib/backend/types';

export function createDefaultBackend(): StudyBackend {
  return isTauri() ? createTauriBackend() : createMemoryBackend();
}

export type { StudyBackend };
