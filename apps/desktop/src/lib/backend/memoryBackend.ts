import { DEFAULT_CHUNK_BYTES, streamUtf8Lossy } from '@/lib/backend/memoryTextStream';
import type { StudyBackend } from '@/lib/backend/types';
import sampleEpubUrl from '../../../../../fixtures/documents/sample.epub?url&no-inline';
import samplePdfUrl from '../../../../../fixtures/documents/sample.pdf?url&no-inline';
import sampleTxtUrl from '../../../../../fixtures/documents/sample.txt?url&no-inline';

import {
  type AnchorLocation,
  type Annotation,
  type AnnotationStyle,
  type Bookmark,
  bookmarkLocationKey,
  DEFAULT_READING_PREFERENCES,
  defaultBookmarkLabel,
  type DocumentFormat,
  type IpcError,
  type MindMapEdge,
  type MindMapNode,
  type NoteCard,
  type ReadingPreferences,
  type StudyDocument,
  type StudyNotebook,
  type WorkspaceSession,
} from '@/types/domain';

/** A file the fake picker can offer, or a loader for one. */
export type MemoryFile = Uint8Array | (() => Promise<Uint8Array>);

/** The PNG signature, in base64. */
const PNG_BASE64_PREFIX = 'iVBORw0KGgo';

function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 0x01000193);
    h2 = Math.imul(h2 ^ byte, 0x01000193);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  const lenHex = bytes.byteLength.toString(16).padStart(8, '0');
  return `memory:${lenHex}:${hex1}${hex2}`;
}

const encodePreview = (text: string) => new TextEncoder().encode(text);

const fetchBytes = (url: string) => async () =>
  new Uint8Array(await (await fetch(url)).arrayBuffer());

const PREVIEW_LIBRARY: Record<string, MemoryFile> = {
  '/preview/sample.txt': fetchBytes(sampleTxtUrl),
  '/preview/sample.pdf': fetchBytes(samplePdfUrl),
  '/preview/sample.epub': fetchBytes(sampleEpubUrl),
  '/preview/sample.md': encodePreview('In-memory preview of a Markdown file\n'),
};

export interface MemoryBackendOptions {
  /** Files by path. The picker offers them in order, then starts over. */
  library?: Record<string, MemoryFile>;
  /** Text stream chunk size, so tests can vary where chunks split. */
  chunkBytes?: number;
}

const FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  pdf: 'pdf',
  epub: 'epub',
  txt: 'txt',
  md: 'md',
};

const fail = (code: string, message: string): IpcError => ({ code, message });

const ANNOTATION_STYLES: readonly string[] = ['highlight', 'underline'] satisfies AnnotationStyle[];

/** Core rejects an unknown style while deserializing the request. */
function checkAnnotationStyle(style: string): void {
  if (!ANNOTATION_STYLES.includes(style)) throw fail('json', `unknown annotation style: ${style}`);
}
const now = () => new Date().toISOString();

/**
 * Non-persistent backend for tests and `pnpm dev:web`. It mirrors the rules of
 * the Rust layer that the UI can observe (referential checks, content identity)
 * but is not a second source of truth: Rust remains authoritative.
 */
export function createMemoryBackend({
  library = PREVIEW_LIBRARY,
  chunkBytes = DEFAULT_CHUNK_BYTES,
}: MemoryBackendOptions = {}): StudyBackend {
  const files: Record<string, MemoryFile> = { ...library };
  const paths = Object.keys(files);
  const documents = new Map<string, StudyDocument>();
  const notebooks = new Map<string, StudyNotebook>();
  const annotations = new Map<string, Annotation>();
  const cards = new Map<string, NoteCard>();
  const nodes = new Map<string, MindMapNode>();
  const edges = new Map<string, MindMapEdge>();
  const captures = new Map<string, string>();
  const bookmarks = new Map<string, Bookmark>();
  let readingPreferences: ReadingPreferences = { ...DEFAULT_READING_PREFERENCES };
  let workspaceSession: WorkspaceSession = {
    openDocumentIds: [],
    activeDocumentId: null,
    immersive: false,
  };
  let picks = 0;
  let clockSeq = 0;
  const monotonicNow = () => {
    clockSeq += 1;
    return new Date(Date.now() + clockSeq).toISOString();
  };

  const validateAnchor = (anchor: AnchorLocation): void => {
    switch (anchor.format) {
      case 'pdf': {
        if (anchor.rects.length === 0) {
          throw fail('invalid_anchor', 'a PDF anchor needs at least one rectangle');
        }
        const inUnit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
        const validRect = (r: { x: number; y: number; width: number; height: number }) =>
          inUnit(r.x) &&
          inUnit(r.y) &&
          r.width > 0 &&
          r.height > 0 &&
          inUnit(r.x + r.width) &&
          inUnit(r.y + r.height);
        if (!anchor.rects.every(validRect)) {
          throw fail(
            'invalid_anchor',
            'PDF rectangles must be non-empty and within the unit square',
          );
        }
        if (anchor.pageSpans !== undefined) {
          if (anchor.pageSpans.length === 0) {
            throw fail('invalid_anchor', 'PDF pageSpans cannot be empty when present');
          }
          if (anchor.pageSpans[0]?.pageIndex !== anchor.pageIndex) {
            throw fail(
              'invalid_anchor',
              "the first PDF pageSpan must match the anchor's primary pageIndex",
            );
          }
          for (const span of anchor.pageSpans) {
            if (span.rects.length === 0 || !span.rects.every(validRect)) {
              throw fail(
                'invalid_anchor',
                'each PDF pageSpan must have valid rectangles within the unit square',
              );
            }
          }
          for (let index = 1; index < anchor.pageSpans.length; index += 1) {
            if (
              (anchor.pageSpans[index - 1]?.pageIndex ?? 0) >=
              (anchor.pageSpans[index]?.pageIndex ?? 0)
            ) {
              throw fail('invalid_anchor', 'PDF pageSpans must be ordered by ascending pageIndex');
            }
          }
        }
        break;
      }
      case 'epub':
        if (!anchor.cfiRange || !anchor.chapterHref) {
          throw fail('invalid_anchor', 'an EPUB anchor needs a CFI range and a chapter href');
        }
        break;
      case 'txt':
        if (anchor.startByteOffset >= anchor.endByteOffset) {
          throw fail('invalid_anchor', 'a TXT anchor must cover at least one byte');
        }
        break;
      case 'md':
        if (!anchor.astNodeId) {
          throw fail('invalid_anchor', 'a Markdown anchor needs an AST node id');
        }
        break;
    }
  };

  const require = <T>(map: Map<string, T>, id: string, entity: string): T => {
    const value = map.get(id);
    if (value === undefined) throw fail('not_found', `${entity} not found: ${id}`);
    return value;
  };

  const inNotebook = <T extends { notebookId: string }>(map: Map<string, T>, notebookId: string) =>
    [...map.values()].filter((value) => value.notebookId === notebookId);

  const parseExtensionFormat = (path: string): { title: string; format: DocumentFormat } => {
    const fileName = path.split('/').pop() ?? path;
    const extension = fileName.includes('.')
      ? (fileName.split('.').pop()?.toLowerCase() ?? '')
      : '';
    const format = FORMAT_BY_EXTENSION[extension];
    if (!format) throw fail('unsupported_format', `unsupported document format: ${extension}`);
    return { title: fileName.replace(/\.[^.]+$/, ''), format };
  };

  const readFile = async (path: string): Promise<Uint8Array> => {
    const file = files[path];
    if (file === undefined) throw fail('io', `no such file: ${path}`);
    return typeof file === 'function' ? file() : file;
  };

  const resolveHash = async (path: string): Promise<string> => {
    try {
      const bytes = await readFile(path);
      return hashBytes(bytes);
    } catch {
      return `memory:${path}`;
    }
  };

  const registerDocument = async (path: string): Promise<StudyDocument> => {
    const { title, format } = parseExtensionFormat(path);
    const fileHash = await resolveHash(path);
    const existing = [...documents.values()].find(
      (document) => document.fileHash === fileHash || document.filePath === path,
    );
    if (existing) {
      const touched: StudyDocument = {
        ...existing,
        filePath: path,
        fileHash,
        lastOpenedAt: monotonicNow(),
      };
      documents.set(touched.id, touched);
      return touched;
    }
    const timestamp = monotonicNow();
    const document: StudyDocument = {
      id: crypto.randomUUID(),
      title,
      filePath: path,
      fileHash,
      format,
      encoding: 'utf-8',
      lastCursorAnchor: null,
      lastOpenedAt: timestamp,
      createdAt: timestamp,
    };
    documents.set(document.id, document);
    return document;
  };

  return {
    kind: 'memory',
    chromeStyle: 'standard',

    async pickDocument() {
      const path = paths[picks % paths.length];
      if (path === undefined) return null;
      picks += 1;
      return registerDocument(path);
    },

    async dropFiles(droppedFiles) {
      const opened: StudyDocument[] = [];
      let error: IpcError | null = null;
      for (const file of droppedFiles) {
        const path = `/dropped/${file.name}`;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          files[path] = bytes;
          const document = await registerDocument(path);
          opened.push(document);
        } catch (err) {
          error ??= err as IpcError;
        }
      }
      return { documents: opened, error };
    },

    onFileDrop: () => () => undefined,

    listDocuments: async () => [...documents.values()],

    async updateDocumentCursor(documentId, anchor) {
      require(documents, documentId, 'document').lastCursorAnchor = anchor;
    },

    async touchDocumentOpened(documentId) {
      const existing = require(documents, documentId, 'document');
      const updated: StudyDocument = { ...existing, lastOpenedAt: monotonicNow() };
      documents.set(documentId, updated);
      return updated;
    },

    async verifyDocumentSource(documentId) {
      const existing = require(documents, documentId, 'document');
      const file = files[existing.filePath];
      if (file === undefined) {
        return {
          documentId: existing.id,
          state: 'missing',
          currentFileHash: null,
          fileSizeBytes: null,
        };
      }
      if (typeof file !== 'function') {
        const currentFileHash = hashBytes(file);
        return {
          documentId: existing.id,
          state: currentFileHash === existing.fileHash ? 'ok' : 'changed',
          currentFileHash,
          fileSizeBytes: file.byteLength,
        };
      }
      try {
        const bytes = await file();
        const currentFileHash = hashBytes(bytes);
        return {
          documentId: existing.id,
          state:
            currentFileHash === existing.fileHash ||
            existing.fileHash === `memory:${existing.filePath}`
              ? 'ok'
              : 'changed',
          currentFileHash,
          fileSizeBytes: bytes.byteLength,
        };
      } catch (err) {
        if (err instanceof TypeError) {
          // Relative preview URL in a test runner without an HTTP server: treat the preview loader as intact.
          return {
            documentId: existing.id,
            state: 'ok',
            currentFileHash: existing.fileHash,
            fileSizeBytes: null,
          };
        }
        return {
          documentId: existing.id,
          state: 'missing',
          currentFileHash: null,
          fileSizeBytes: null,
        };
      }
    },

    async relinkDocument(documentId, confirmInPlace = false) {
      const existing = require(documents, documentId, 'document');
      let targetPath: string;
      if (confirmInPlace) {
        targetPath = existing.filePath;
      } else {
        const currentKeys = Object.keys(files);
        const picked = currentKeys[picks % currentKeys.length];
        if (picked === undefined) return null;
        picks += 1;
        targetPath = picked;
      }

      const { title, format } = parseExtensionFormat(targetPath);
      if (format !== existing.format) {
        throw fail(
          'unsupported_format',
          `cannot relink a ${existing.format} document to a ${format} file`,
        );
      }

      const newHash = await resolveHash(targetPath);
      const collision = [...documents.values()].find(
        (doc) => doc.id !== documentId && doc.fileHash === newHash,
      );
      if (collision) {
        throw fail(
          'invalid_graph',
          'that file is already registered as another document in your library',
        );
      }

      const contentChanged = newHash !== existing.fileHash;
      const updated: StudyDocument = {
        ...existing,
        title,
        filePath: targetPath,
        fileHash: newHash,
        lastCursorAnchor: contentChanged ? null : existing.lastCursorAnchor,
        lastOpenedAt: monotonicNow(),
      };
      documents.set(documentId, updated);
      return {
        document: updated,
        contentChanged,
        previousFileHash: existing.fileHash,
      };
    },

    async getWorkspaceSession() {
      const openDocumentIds = workspaceSession.openDocumentIds.filter((id) => documents.has(id));
      const activeDocumentId =
        workspaceSession.activeDocumentId &&
        openDocumentIds.includes(workspaceSession.activeDocumentId)
          ? workspaceSession.activeDocumentId
          : (openDocumentIds.at(-1) ?? null);
      return { openDocumentIds, activeDocumentId, immersive: workspaceSession.immersive };
    },

    async saveWorkspaceSession(session) {
      const openDocumentIds: string[] = [];
      for (const id of session.openDocumentIds) {
        if (!openDocumentIds.includes(id) && documents.has(id)) {
          openDocumentIds.push(id);
        }
      }
      const activeDocumentId =
        session.activeDocumentId && openDocumentIds.includes(session.activeDocumentId)
          ? session.activeDocumentId
          : (openDocumentIds.at(-1) ?? null);
      workspaceSession = { openDocumentIds, activeDocumentId, immersive: session.immersive };
      return { ...workspaceSession };
    },

    async createNotebook(title) {
      const notebook: StudyNotebook = {
        id: crypto.randomUUID(),
        title,
        viewport: null,
        createdAt: now(),
      };
      notebooks.set(notebook.id, notebook);
      return notebook;
    },

    listNotebooks: async () => [...notebooks.values()],

    async saveNotebookViewport(notebookId, viewport) {
      require(notebooks, notebookId, 'notebook').viewport = viewport;
    },

    async loadNotebookGraph(notebookId) {
      return {
        notebook: require(notebooks, notebookId, 'notebook'),
        annotations: inNotebook(annotations, notebookId),
        cards: inNotebook(cards, notebookId),
        nodes: inNotebook(nodes, notebookId),
        edges: inNotebook(edges, notebookId),
      };
    },

    async createExcerpt(input) {
      validateAnchor(input.anchor);
      const document = require(documents, input.documentId, 'document');
      require(notebooks, input.notebookId, 'notebook');
      if (document.format !== input.anchor.format) {
        throw fail(
          'invalid_anchor',
          `${input.anchor.format} anchor on a ${document.format} document`,
        );
      }
      if (input.parentNodeId) require(nodes, input.parentNodeId, 'node');
      if (!input.excerptText?.trim() && input.excerptImagePng === null) {
        throw fail('invalid_anchor', 'an excerpt needs text or a captured image');
      }
      if (input.excerptImagePng !== null && !input.excerptImagePng.startsWith(PNG_BASE64_PREFIX)) {
        throw fail('invalid_capture', 'the image is not a PNG');
      }

      const annotationId = crypto.randomUUID();
      if (input.excerptImagePng !== null) captures.set(annotationId, input.excerptImagePng);
      const annotation: Annotation = {
        id: annotationId,
        documentId: input.documentId,
        notebookId: input.notebookId,
        anchor: input.anchor,
        excerptText: input.excerptText,
        excerptImagePath: input.excerptImagePng === null ? null : `captures/${annotationId}.png`,
        note: null,
        color: input.color,
        style: 'highlight',
        createdAt: now(),
      };
      const card: NoteCard = {
        id: crypto.randomUUID(),
        notebookId: input.notebookId,
        title: input.excerptText?.trim().split('\n')[0]?.slice(0, 80) || 'Image excerpt',
        markdownNotes: '',
        tags: [],
        annotationIds: [annotation.id],
        createdAt: now(),
      };
      const node: MindMapNode = {
        id: crypto.randomUUID(),
        notebookId: input.notebookId,
        cardId: card.id,
        parentNodeId: input.parentNodeId,
        posX: input.posX,
        posY: input.posY,
        isCollapsed: false,
        style: null,
      };
      const edge: MindMapEdge | null = input.parentNodeId
        ? {
            id: crypto.randomUUID(),
            notebookId: input.notebookId,
            sourceNodeId: input.parentNodeId,
            targetNodeId: node.id,
            label: null,
          }
        : null;

      annotations.set(annotation.id, annotation);
      cards.set(card.id, card);
      nodes.set(node.id, node);
      if (edge) edges.set(edge.id, edge);
      return { annotation, card, node, edge };
    },

    async createAnnotation(input) {
      validateAnchor(input.anchor);
      const document = require(documents, input.documentId, 'document');
      require(notebooks, input.notebookId, 'notebook');
      if (document.format !== input.anchor.format) {
        throw fail(
          'invalid_anchor',
          `${input.anchor.format} anchor on a ${document.format} document`,
        );
      }
      if (!input.color.trim()) {
        throw fail('invalid_anchor', 'an annotation needs a highlight color');
      }
      checkAnnotationStyle(input.style);
      const trimmedNote = input.note?.trim() || null;
      if (!input.excerptText?.trim() && input.excerptImagePng === null && trimmedNote === null) {
        throw fail(
          'invalid_anchor',
          'an annotation needs selected text, a note, or a captured image',
        );
      }
      if (input.excerptImagePng !== null && !input.excerptImagePng.startsWith(PNG_BASE64_PREFIX)) {
        throw fail('invalid_capture', 'the image is not a PNG');
      }

      const annotationId = crypto.randomUUID();
      if (input.excerptImagePng !== null) captures.set(annotationId, input.excerptImagePng);
      const annotation: Annotation = {
        id: annotationId,
        documentId: input.documentId,
        notebookId: input.notebookId,
        anchor: input.anchor,
        excerptText: input.excerptText,
        excerptImagePath: input.excerptImagePng === null ? null : `captures/${annotationId}.png`,
        note: trimmedNote,
        color: input.color.trim(),
        style: input.style,
        createdAt: now(),
      };
      annotations.set(annotation.id, annotation);
      return annotation;
    },

    async updateAnnotation(annotationId, patch) {
      const existing = require(annotations, annotationId, 'annotation');
      if (patch.color !== null && !patch.color.trim()) {
        throw fail('invalid_anchor', 'an annotation needs a highlight color');
      }
      if (patch.style != null) checkAnnotationStyle(patch.style);
      const updated: Annotation = {
        ...existing,
        note: patch.note !== null ? patch.note.trim() || null : (existing.note ?? null),
        color: patch.color !== null ? patch.color.trim() : existing.color,
        style: patch.style ?? existing.style,
      };
      annotations.set(annotationId, updated);
      return updated;
    },

    async deleteAnnotation(annotationId) {
      require(annotations, annotationId, 'annotation');
      annotations.delete(annotationId);
      captures.delete(annotationId);
      for (const [cardId, card] of cards) {
        if (card.annotationIds.includes(annotationId)) {
          cards.set(cardId, {
            ...card,
            annotationIds: card.annotationIds.filter((id) => id !== annotationId),
          });
        }
      }
    },

    async updateCard(cardId, patch) {
      const card = require(cards, cardId, 'card');
      const updated: NoteCard = {
        ...card,
        title: patch.title ?? card.title,
        markdownNotes: patch.markdownNotes ?? card.markdownNotes,
        tags: patch.tags ?? card.tags,
      };
      cards.set(cardId, updated);
      return updated;
    },

    async updateNodeLayout(nodeId, patch) {
      Object.assign(require(nodes, nodeId, 'node'), patch);
    },

    async createEdge(notebookId, sourceNodeId, targetNodeId, label) {
      if (sourceNodeId === targetNodeId) {
        throw fail('invalid_graph', 'a node cannot link to itself');
      }
      require(nodes, sourceNodeId, 'node');
      require(nodes, targetNodeId, 'node');
      const duplicate = [...edges.values()].some(
        (edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId,
      );
      if (duplicate) throw fail('database', 'these nodes are already linked');
      const edge: MindMapEdge = {
        id: crypto.randomUUID(),
        notebookId,
        sourceNodeId,
        targetNodeId,
        label,
      };
      edges.set(edge.id, edge);
      return edge;
    },

    async deleteEdge(edgeId) {
      require(edges, edgeId, 'edge');
      edges.delete(edgeId);
    },

    async captureUrl(annotationId) {
      require(annotations, annotationId, 'annotation');
      const png = captures.get(annotationId);
      return png === undefined ? null : `data:image/png;base64,${png}`;
    },

    async getReadingPreferences() {
      return { ...readingPreferences };
    },

    async saveReadingPreferences(preferences) {
      if (
        !Number.isInteger(preferences.fontSize) ||
        preferences.fontSize < 75 ||
        preferences.fontSize > 200
      ) {
        throw fail('invalid_preferences', 'fontSize must be between 75 and 200');
      }
      if (
        !Number.isFinite(preferences.lineSpacing) ||
        preferences.lineSpacing < 1.2 ||
        preferences.lineSpacing > 2.4
      ) {
        throw fail('invalid_preferences', 'lineSpacing must be between 1.2 and 2.4');
      }
      if (!['standard', 'wide', 'full'].includes(preferences.pageWidth)) {
        throw fail('invalid_preferences', 'pageWidth must be standard, wide, or full');
      }
      if (!['none', 'slide', 'fade', 'flip', 'stack'].includes(preferences.pageTransition)) {
        throw fail(
          'invalid_preferences',
          'pageTransition must be none, slide, fade, flip, or stack',
        );
      }
      readingPreferences = { ...preferences };
      return { ...readingPreferences };
    },

    listBookmarks: async () => [...bookmarks.values()],

    async createBookmark(input) {
      validateAnchor(input.anchor);
      const document = require(documents, input.documentId, 'document');
      if (document.format !== input.anchor.format) {
        throw fail(
          'invalid_anchor',
          `${input.anchor.format} anchor on a ${document.format} document`,
        );
      }
      const firstLine = input.label
        ?.split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      const label = firstLine
        ? firstLine.length <= 80
          ? firstLine
          : `${firstLine.slice(0, 79)}…`
        : defaultBookmarkLabel(input.anchor);
      const key = bookmarkLocationKey(input.anchor);
      const existing = [...bookmarks.values()].find(
        (candidate) =>
          candidate.documentId === input.documentId &&
          bookmarkLocationKey(candidate.anchor) === key,
      );
      if (existing) {
        const updated: Bookmark = {
          ...existing,
          anchor: input.anchor,
          label,
        };
        bookmarks.set(updated.id, updated);
        return updated;
      }
      const bookmark: Bookmark = {
        id: crypto.randomUUID(),
        documentId: input.documentId,
        anchor: input.anchor,
        label,
        createdAt: now(),
      };
      bookmarks.set(bookmark.id, bookmark);
      return bookmark;
    },

    async deleteBookmark(bookmarkId) {
      require(bookmarks, bookmarkId, 'bookmark');
      bookmarks.delete(bookmarkId);
    },

    // A browser has no native menu; the keyboard and toolbar reach every command.
    onMenuCommand: () => () => undefined,
    setMenuItemStates: async () => undefined,
    // The page's Fullscreen API stands in for the window's in the browser preview.
    isFullscreen: async () => globalThis.document?.fullscreenElement != null,
    async setFullscreen(fullscreen) {
      const page = globalThis.document;
      if (!page) return;
      if (fullscreen && !page.fullscreenElement) {
        await page.documentElement.requestFullscreen?.();
      } else if (!fullscreen && page.fullscreenElement) {
        await page.exitFullscreen?.();
      }
    },
    onFullscreenChange(listener) {
      const page = globalThis.document;
      if (!page) return () => undefined;
      const onChange = () => listener(page.fullscreenElement != null);
      page.addEventListener('fullscreenchange', onChange);
      return () => page.removeEventListener('fullscreenchange', onChange);
    },

    loadDocumentSource: async (document) => ({
      kind: 'bytes',
      bytes: await readFile(document.filePath),
    }),

    async readTextStream(documentId, encoding, onChunk, signal) {
      const document = require(documents, documentId, 'document');
      if (encoding !== null && !/^\s*utf-?8\s*$/i.test(encoding)) {
        throw fail('unsupported_encoding', `unsupported text encoding: ${encoding}`);
      }
      if (signal?.aborted) return 0;
      const bytes = await readFile(document.filePath);
      if (signal?.aborted) return 0;
      return streamUtf8Lossy(bytes, chunkBytes, onChunk, signal);
    },
  };
}
