import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';

import type { StudyBackend } from '@/lib/backend/types';
import type {
  CreatedExcerpt,
  MindMapEdge,
  NoteCard,
  NotebookGraph,
  StudyDocument,
  StudyNotebook,
  TextChunk,
} from '@/types/domain';

export function createTauriBackend(): StudyBackend {
  return {
    kind: 'tauri',

    pickDocument: () => invoke<StudyDocument | null>('pick_document'),
    listDocuments: () => invoke<StudyDocument[]>('list_documents'),
    updateDocumentCursor: (documentId, anchor) =>
      invoke('update_document_cursor', { documentId, anchor }),

    createNotebook: (title) => invoke<StudyNotebook>('create_notebook', { title }),
    listNotebooks: () => invoke<StudyNotebook[]>('list_notebooks'),
    saveNotebookViewport: (notebookId, viewport) =>
      invoke('save_notebook_viewport', { notebookId, viewport }),
    loadNotebookGraph: (notebookId) => invoke<NotebookGraph>('load_notebook_graph', { notebookId }),

    createExcerpt: (input) => invoke<CreatedExcerpt>('create_excerpt', { input }),
    updateCard: (cardId, patch) => invoke<NoteCard>('update_card', { cardId, patch }),
    updateNodeLayout: (nodeId, patch) => invoke('update_node_layout', { nodeId, patch }),
    createEdge: (notebookId, sourceNodeId, targetNodeId, label) =>
      invoke<MindMapEdge>('create_edge', { notebookId, sourceNodeId, targetNodeId, label }),
    deleteEdge: (edgeId) => invoke('delete_edge', { edgeId }),

    // The asset protocol enforces its scope in Rust, whatever this URL names.
    loadDocumentSource: async (document) => ({
      kind: 'url',
      url: convertFileSrc(document.filePath),
    }),

    readTextStream(documentId, encoding, onChunk) {
      const channel = new Channel<TextChunk>();
      channel.onmessage = onChunk;
      return invoke<number>('read_text_stream', { documentId, encoding, onChunk: channel });
    },
  };
}
