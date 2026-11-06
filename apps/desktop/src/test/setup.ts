import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom lacks the layout APIs that React Flow and the panel library observe.
class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub;

afterEach(() => {
  cleanup();
  // The reader sidebar remembers its tab and width per format; each test starts fresh.
  localStorage.clear();
});
