import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanShareDialog } from '@/features/lanSync/LanShareDialog';
import { createMemoryBackend } from '@/lib/backend/memoryBackend';
import type { StudyBackend } from '@/lib/backend/types';
import { createStudySyncStore, useStudySyncStore } from '@/stores/useStudySyncStore';
import {
  INITIAL_LAN_SHARE_SNAPSHOT,
  type LanShareSnapshot,
  type StudyDocument,
} from '@/types/domain';

const initialStoreState = useStudySyncStore.getState();

function makeDoc(overrides: Partial<StudyDocument> & { id: string; title: string }): StudyDocument {
  return {
    filePath: `/docs/${overrides.id}.txt`,
    fileHash: `hash-${overrides.id}`,
    format: 'txt',
    encoding: 'utf-8',
    lastCursorAnchor: null,
    lastOpenedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    lastProgress: null,
    ...overrides,
  };
}

const DEFAULT_DOCS: StudyDocument[] = [
  makeDoc({ id: 'doc-1', title: 'Alpha Book', filePath: '/docs/alpha.txt', format: 'txt' }),
  makeDoc({ id: 'doc-2', title: 'Beta Notes', filePath: '/docs/beta.md', format: 'txt' }),
];

let unbindStore: (() => void) | null = null;

function bindTestStore(backend: StudyBackend = createMemoryBackend(), docs = DEFAULT_DOCS) {
  unbindStore?.();
  const temp = createStudySyncStore(backend);
  temp.setState({ documents: docs });
  useStudySyncStore.setState(temp.getState(), true);
  unbindStore = temp.subscribe((next) => {
    useStudySyncStore.setState(next);
  });
  return temp;
}

describe('LanShareDialog', () => {
  beforeEach(() => {
    bindTestStore();
  });

  afterEach(() => {
    unbindStore?.();
    unbindStore = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    useStudySyncStore.setState(initialStoreState, true);
    document.body.innerHTML = '';
  });

  it('shows pre-start options, multi-interface picker, searchable scope, and handles declined confirmation', async () => {
    const backend = createMemoryBackend({
      lanPeer: {
        confirmShare: false,
        interfaces: [
          { name: 'en0', subnet: { ip: '192.168.1.42', netmask: '255.255.255.0', prefixLen: 24 } },
          { name: 'en5', subnet: { ip: '10.0.0.15', netmask: '255.255.255.0', prefixLen: 24 } },
        ],
      },
    });
    const startSpy = vi.spyOn(backend, 'lanShareStart');
    bindTestStore(backend, DEFAULT_DOCS);

    render(<LanShareDialog open onClose={() => undefined} />);

    expect(await screen.findByTestId('lan-share-interface-select')).toBeInTheDocument();
    expect(screen.getByTestId('lan-share-plaintext-notice')).toHaveTextContent(
      'Use only on networks you trust. Transfers are not encrypted.',
    );

    // Switch to selected books and filter for Beta Notes (Markdown).
    fireEvent.click(screen.getByTestId('lan-share-scope-selected'));
    expect(screen.getByTestId('lan-share-start')).toBeDisabled();
    fireEvent.change(screen.getByTestId('lan-share-book-search'), {
      target: { value: 'Markdown' },
    });
    expect(screen.queryByText('Alpha Book')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Notes')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lan-share-book-checkbox-doc-2'));
    fireEvent.click(screen.getByTestId('lan-share-perm-positions'));
    fireEvent.change(screen.getByTestId('lan-share-interface-select'), {
      target: { value: '10.0.0.15' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-share-start'));
    });

    expect(startSpy).toHaveBeenCalledWith({
      documentIds: ['doc-2'],
      positions: false,
      bookmarks: true,
      interfaceIp: '10.0.0.15',
    });
    expect(useStudySyncStore.getState().lanShare.snapshot.status.state).toBe('off');
  });

  it('starts sharing, copies address via clipboard or selection fallback, and counts down expiry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = new Date('2026-11-23T10:00:00.000Z').getTime();
    vi.setSystemTime(now);

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const activeSnapshot: LanShareSnapshot = {
      status: { state: 'listening', failedAttempts: 2, maxFailedAttempts: 5 },
      address: '192.168.1.42:49319',
      interfaceName: 'en0',
      pairingCode: '482913',
      codeExpiresAtMs: now + 125_000,
      permissions: { positions: true, bookmarks: true },
      sharedBookCount: 2,
      blockedPeerCount: 0,
      lastBlockedPeerIp: null,
      lastStopReason: null,
      lastStopErrorCode: null,
    };

    const backend = createMemoryBackend();
    let currentStatus: LanShareSnapshot = { ...INITIAL_LAN_SHARE_SNAPSHOT };
    vi.spyOn(backend, 'lanShareStart').mockImplementation(async () => {
      currentStatus = activeSnapshot;
      return activeSnapshot;
    });
    vi.spyOn(backend, 'lanShareStatus').mockImplementation(async () => currentStatus);
    bindTestStore(backend, DEFAULT_DOCS);

    const onClose = vi.fn();
    render(<LanShareDialog open onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByTestId('lan-share-single-interface')).toHaveTextContent('192.168.1.42'),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-share-start'));
    });

    expect(screen.getByTestId('lan-share-status-badge')).toHaveTextContent('Listening');
    expect(screen.getByTestId('lan-share-address')).toHaveTextContent('192.168.1.42:49319');
    expect(screen.getByTestId('lan-share-address')).toHaveClass('select-all');
    expect(screen.getByTestId('lan-share-code')).toHaveTextContent('482913');
    expect(screen.getByTestId('lan-share-countdown')).toHaveTextContent('Expires in 2:05');
    expect(screen.getByTestId('lan-share-failed-attempts')).toHaveTextContent(
      '2 of 5 incorrect attempts used',
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('lan-share-countdown')).toHaveTextContent('Expires in 2:00');

    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-share-copy-address'));
    });
    expect(writeText).toHaveBeenCalledWith('192.168.1.42:49319');
    expect(screen.getByTestId('lan-share-copy-address')).toHaveTextContent('Copied');

    // Clipboard failure selects address text as manual fallback (`T-53`).
    writeText.mockRejectedValueOnce(new Error('clipboard blocked'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-share-copy-address'));
    });
    expect(screen.getByText(/press Copy to copy it manually/i)).toBeInTheDocument();

    // Closing the modal keeps sharing active.
    fireEvent.click(screen.getByTestId('lan-share-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useStudySyncStore.getState().lanShare.snapshot.status.state).toBe('listening');
  });

  it('handles 5-failure codeLocked + Regenerate, paired peer IP, blocked-peer notice, and stop reasons', async () => {
    let snapshot: LanShareSnapshot = {
      status: { state: 'codeLocked' },
      address: '192.168.1.42:49319',
      interfaceName: 'en0',
      pairingCode: null,
      codeExpiresAtMs: Date.now() + 60_000,
      permissions: { positions: true, bookmarks: false },
      sharedBookCount: 1,
      blockedPeerCount: 2,
      lastBlockedPeerIp: '10.99.0.5',
      lastStopReason: null,
      lastStopErrorCode: null,
    };

    const backend = createMemoryBackend();
    vi.spyOn(backend, 'lanShareStatus').mockImplementation(async () => snapshot);
    const regenerateSpy = vi
      .spyOn(backend, 'lanShareRegenerateCode')
      .mockImplementation(async () => {
        snapshot = {
          ...snapshot,
          status: { state: 'listening', failedAttempts: 0, maxFailedAttempts: 5 },
          pairingCode: '739104',
        };
        return snapshot;
      });
    const disconnectSpy = vi
      .spyOn(backend, 'lanShareDisconnectPeer')
      .mockImplementation(async () => {
        snapshot = {
          ...INITIAL_LAN_SHARE_SNAPSHOT,
          lastStopReason: 'stoppedByUser',
        };
        return snapshot;
      });

    const temp = bindTestStore(backend);
    temp.setState((state) => ({
      lanShare: { ...state.lanShare, snapshot },
    }));

    render(<LanShareDialog open onClose={() => undefined} />);

    expect(screen.getByTestId('lan-share-code-locked')).toHaveTextContent(
      'Code locked after 5 failed attempts',
    );
    expect(screen.getByTestId('lan-share-blocked-peer-notice')).toHaveTextContent('10.99.0.5');

    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-share-regenerate-code'));
    });
    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lan-share-code')).toHaveTextContent('739104');

    // Transition to paired receiver (IP only, zero hostname: `OD-9`).
    snapshot = {
      ...snapshot,
      status: { state: 'paired', peerIp: '192.168.1.88' },
      pairingCode: null,
    };
    act(() => {
      temp.setState((state) => ({
        lanShare: { ...state.lanShare, snapshot },
      }));
    });
    expect(screen.getByTestId('lan-share-status-badge')).toHaveTextContent('Connected');
    expect(screen.getByTestId('lan-share-peer-ip')).toHaveTextContent('192.168.1.88');

    await act(async () => {
      fireEvent.click(screen.getByTestId('lan-share-disconnect-peer'));
    });
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lan-share-stop-banner')).toHaveTextContent('Sharing stopped.');

    // Network-change stop surfaces warning attention banner.
    snapshot = {
      ...INITIAL_LAN_SHARE_SNAPSHOT,
      lastStopReason: 'networkChanged',
      lastStopErrorCode: 'lan_network_changed',
    };
    act(() => {
      temp.setState((state) => ({
        lanShare: { ...state.lanShare, snapshot },
      }));
    });
    expect(screen.getByTestId('lan-share-stop-banner')).toHaveTextContent('Needs attention');
    expect(screen.getByTestId('lan-share-stop-banner')).toHaveTextContent('network changed');
  });
});
