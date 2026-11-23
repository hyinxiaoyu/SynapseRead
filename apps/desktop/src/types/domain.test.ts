import { describe, expect, it } from 'vitest';

import anchors from '../../../../fixtures/contract/anchors.json';
import {
  isAnchorLocation,
  isLanImportExecutionReport,
  isLanImportPlanResult,
  isLanImportProgress,
  isLanShareEventPayload,
} from './domain';

describe('isAnchorLocation', () => {
  it('accepts every anchor in the fixture shared with Rust', () => {
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(isAnchorLocation(anchor)).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['unknown format', { format: 'docx' }],
    ['pdf without rects', { format: 'pdf', pageIndex: 0 }],
    ['pdf with bad rect', { format: 'pdf', pageIndex: 0, rects: [{ x: 0 }] }],
    [
      'pdf with empty pageSpans',
      {
        format: 'pdf',
        pageIndex: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
        pageSpans: [],
      },
    ],
    [
      'pdf with mismatched first pageSpan pageIndex',
      {
        format: 'pdf',
        pageIndex: 0,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
        pageSpans: [{ pageIndex: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] }],
      },
    ],
    [
      'pdf with non-ascending pageSpans',
      {
        format: 'pdf',
        pageIndex: 1,
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
        pageSpans: [
          { pageIndex: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.05 }] },
          { pageIndex: 1, rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.05 }] },
        ],
      },
    ],
    ['epub without href', { format: 'epub', cfiRange: 'x' }],
    [
      'txt with string offset',
      { format: 'txt', startByteOffset: '0', endByteOffset: 1, lineIndex: 0 },
    ],
    ['md without node', { format: 'md', offset: 0 }],
  ])('rejects %s', (_name, value) => {
    expect(isAnchorLocation(value)).toBe(false);
  });
});

describe('LAN sync DTO runtime guards', () => {
  const validPlanBook = {
    bookId: 'a'.repeat(64),
    title: 'Sample Book',
    format: 'txt',
    extension: 'txt',
    sizeBytes: 128,
    state: 'new',
    eligible: true,
    needsFileDownload: true,
    localDocumentId: null,
    localTitle: null,
    position: {
      remoteAvailable: true,
      remoteProgress: 0.4,
      localHasPosition: false,
      localProgress: null,
      differs: true,
      defaultAdopt: true,
    },
    bookmarks: {
      newCount: 1,
      existingCount: 0,
      skippedCount: 1,
      entries: [
        {
          index: 0,
          label: 'Chapter 1',
          createdAt: '2026-11-18T10:00:00.000Z',
          status: { status: 'new' },
        },
        {
          index: 1,
          label: 'Future',
          createdAt: null,
          status: {
            status: 'skipped',
            reason: { kind: 'unsupportedAnchor', reason: 'unknown format' },
          },
        },
      ],
      defaultImport: true,
    },
  };

  const validPlanResult = {
    planId: 'plan-1',
    summary: { books: [validPlanBook] },
    defaultDecisions: [
      {
        bookId: 'a'.repeat(64),
        importFile: true,
        importPosition: true,
        importBookmarks: true,
        overridePositionConflict: false,
      },
    ],
  };

  const validSnapshot = {
    status: { state: 'listening', failedAttempts: 0, maxFailedAttempts: 5 },
    address: '192.168.1.42:49319',
    interfaceName: 'en0',
    pairingCode: '123456',
    codeExpiresAtMs: 1_700_000_000_000,
    permissions: { positions: true, bookmarks: true },
    sharedBookCount: 2,
    blockedPeerCount: 1,
    lastBlockedPeerIp: '10.0.0.5',
    lastStopReason: null,
    lastStopErrorCode: null,
  };

  it('accepts Rust-serialized plan, progress, report, and share event payloads', () => {
    expect(isLanImportPlanResult(validPlanResult)).toBe(true);

    for (const reason of ['nonIpv4', 'nonPrivateAddress', 'outOfSubnet'] as const) {
      expect(
        isLanShareEventPayload({
          event: { kind: 'peerBlocked', peerIp: '10.0.0.5', reason, totalBlocked: 1 },
          snapshot: validSnapshot,
        }),
      ).toBe(true);
    }

    expect(
      isLanShareEventPayload({
        event: { kind: 'stopped', reason: 'networkChanged', errorCode: 'lan_network_changed' },
        snapshot: {
          ...validSnapshot,
          status: { state: 'off' },
          lastStopReason: 'networkChanged',
          lastStopErrorCode: 'lan_network_changed',
        },
      }),
    ).toBe(true);

    const bookResult = {
      bookId: 'a'.repeat(64),
      documentId: 'doc-1',
      state: 'alreadyPresent',
      file: { status: 'skipped' },
      position: {
        status: 'conflict',
        code: 'lan_position_conflict',
        hasCurrentPosition: true,
        currentProgress: 0.25,
      },
      bookmarks: { status: 'applied' },
      bookmarkCounts: { inserted: 1, existing: 0, skipped: 0 },
    };

    expect(
      isLanImportProgress({
        phase: 'bookCompleted',
        bookId: 'a'.repeat(64),
        bookIndex: 0,
        totalBooks: 1,
        result: bookResult,
      }),
    ).toBe(true);

    expect(
      isLanImportExecutionReport({
        books: [bookResult],
        cancelled: false,
      }),
    ).toBe(true);
  });

  it('rejects malformed nested plan, decision, and share event payloads', () => {
    expect(isLanImportPlanResult(null)).toBe(false);
    expect(
      isLanImportPlanResult({
        ...validPlanResult,
        summary: { books: [{ ...validPlanBook, position: {} }] },
      }),
    ).toBe(false);
    expect(
      isLanImportPlanResult({
        ...validPlanResult,
        summary: { books: [{ ...validPlanBook, bookmarks: {} }] },
      }),
    ).toBe(false);
    expect(
      isLanImportPlanResult({
        ...validPlanResult,
        defaultDecisions: [null],
      }),
    ).toBe(false);
    expect(
      isLanShareEventPayload({
        event: { kind: 'peerBlocked', peerIp: '10.0.0.5', reason: 'nonLanIp', totalBlocked: 1 },
        snapshot: validSnapshot,
      }),
    ).toBe(false);
    expect(
      isLanShareEventPayload({
        event: {
          kind: 'peerBlocked',
          peerIp: '10.0.0.5',
          reason: 'outsideSubnet',
          totalBlocked: 1,
        },
        snapshot: validSnapshot,
      }),
    ).toBe(false);
    expect(
      isLanImportExecutionReport({
        books: [null],
        cancelled: false,
      }),
    ).toBe(false);
  });
});
