import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

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

const DOCUMENT_EXTENSIONS = ['pdf', 'epub', 'txt', 'text', 'log', 'md', 'markdown'];

export function createTauriBackend(): StudyBackend {
  return {
    kind: 'tauri',

    async pickDocumentPath() {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Documents', extensions: DOCUMENT_EXTENSIONS }],
      });
      return selected;
    },
    registerDocument: (path) => invoke<StudyDocument>('register_document', { path }),
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

    readTextStream(path, encoding, onChunk) {
      const channel = new Channel<TextChunk>();
      channel.onmessage = onChunk;
      return invoke<number>('read_text_stream', { path, encoding, onChunk: channel });
    },
  };
}
