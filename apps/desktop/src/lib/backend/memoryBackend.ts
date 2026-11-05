import { DEFAULT_CHUNK_BYTES, streamUtf8Lossy } from '@/lib/backend/memoryTextStream';
import type { StudyBackend } from '@/lib/backend/types';
import sampleTxtUrl from '../../../../../fixtures/documents/sample.txt?url&no-inline';

import type {
  Annotation,
  DocumentFormat,
  IpcError,
  MindMapEdge,
  MindMapNode,
  NoteCard,
  StudyDocument,
  StudyNotebook,
} from '@/types/domain';

/** A file the fake picker can offer, or a loader for one. */
export type MemoryFile = Uint8Array | (() => Promise<Uint8Array>);

const encodePreview = (text: string) => new TextEncoder().encode(text);

const fetchBytes = (url: string) => async () =>
  new Uint8Array(await (await fetch(url)).arrayBuffer());

const PREVIEW_LIBRARY: Record<string, MemoryFile> = {
  '/preview/sample.txt': fetchBytes(sampleTxtUrl),
  '/preview/sample.pdf': encodePreview('In-memory preview of a PDF\n'),
  '/preview/sample.epub': encodePreview('In-memory preview of an EPUB\n'),
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
  const paths = Object.keys(library);
  const documents = new Map<string, StudyDocument>();
  const notebooks = new Map<string, StudyNotebook>();
  const annotations = new Map<string, Annotation>();
  const cards = new Map<string, NoteCard>();
  const nodes = new Map<string, MindMapNode>();
  const edges = new Map<string, MindMapEdge>();
  let picks = 0;

  const require = <T>(map: Map<string, T>, id: string, entity: string): T => {
    const value = map.get(id);
    if (value === undefined) throw fail('not_found', `${entity} not found: ${id}`);
    return value;
  };

  const inNotebook = <T extends { notebookId: string }>(map: Map<string, T>, notebookId: string) =>
    [...map.values()].filter((value) => value.notebookId === notebookId);

  const registerDocument = (path: string): StudyDocument => {
    const existing = [...documents.values()].find((document) => document.filePath === path);
    if (existing) return existing;
    const fileName = path.split('/').pop() ?? path;
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    const format = FORMAT_BY_EXTENSION[extension];
    if (!format) throw fail('unsupported_format', `unsupported document format: ${extension}`);
    const document: StudyDocument = {
      id: crypto.randomUUID(),
      title: fileName.replace(/\.[^.]+$/, ''),
      filePath: path,
      fileHash: `memory:${path}`,
      format,
      encoding: 'utf-8',
      lastCursorAnchor: null,
      createdAt: now(),
    };
    documents.set(document.id, document);
    return document;
  };

  const readFile = async (path: string): Promise<Uint8Array> => {
    const file = library[path];
    if (file === undefined) throw fail('io', `no such file: ${path}`);
    return typeof file === 'function' ? file() : file;
  };

  return {
    kind: 'memory',

    async pickDocument() {
      const path = paths[picks % paths.length];
      if (path === undefined) return null;
      picks += 1;
      return registerDocument(path);
    },

    listDocuments: async () => [...documents.values()],

    async updateDocumentCursor(documentId, anchor) {
      require(documents, documentId, 'document').lastCursorAnchor = anchor;
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
      const document = require(documents, input.documentId, 'document');
      require(notebooks, input.notebookId, 'notebook');
      if (document.format !== input.anchor.format) {
        throw fail(
          'invalid_anchor',
          `${input.anchor.format} anchor on a ${document.format} document`,
        );
      }
      if (input.parentNodeId) require(nodes, input.parentNodeId, 'node');

      const annotation: Annotation = {
        id: crypto.randomUUID(),
        documentId: input.documentId,
        notebookId: input.notebookId,
        anchor: input.anchor,
        excerptText: input.excerptText,
        excerptImagePath: input.excerptImagePath,
        color: input.color,
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

    loadDocumentSource: async (document) => ({
      kind: 'bytes',
      bytes: await readFile(document.filePath),
    }),

    async readTextStream(documentId, encoding, onChunk) {
      const document = require(documents, documentId, 'document');
      if (encoding !== null && !/^\s*utf-?8\s*$/i.test(encoding)) {
        throw fail('unsupported_encoding', `unsupported text encoding: ${encoding}`);
      }
      return streamUtf8Lossy(await readFile(document.filePath), chunkBytes, onChunk);
    },
  };
}
