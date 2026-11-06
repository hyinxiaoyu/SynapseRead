import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';

import type { DroppedDocumentsPayload, StudyBackend } from '@/lib/backend/types';
import type {
  Bookmark,
  CreatedExcerpt,
  MindMapEdge,
  NoteCard,
  NotebookGraph,
  ReadingPreferences,
  StudyDocument,
  StudyNotebook,
  TextChunk,
} from '@/types/domain';

const DOCUMENTS_DROPPED_EVENT = 'synapse://documents-dropped';

export function createTauriBackend(): StudyBackend {
  return {
    kind: 'tauri',

    pickDocument: () => invoke<StudyDocument | null>('pick_document'),
    dropFiles: async () => ({ documents: [], error: null }),
    onFileDrop(listener) {
      let disposed = false;
      const unlisteners: UnlistenFn[] = [];
      const bind = <T>(event: string, handler: (payload: T) => void) => {
        void listen<T>(event, (target) => {
          if (!disposed) handler(target.payload);
        }).then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlisteners.push(unlisten);
          }
        });
      };
      bind(TauriEvent.DRAG_ENTER, () => listener({ type: 'enter' }));
      bind(TauriEvent.DRAG_LEAVE, () => listener({ type: 'leave' }));
      bind(TauriEvent.DRAG_DROP, () => listener({ type: 'leave' }));
      bind<DroppedDocumentsPayload>(DOCUMENTS_DROPPED_EVENT, (payload) => {
        listener({
          type: 'drop',
          documents: payload.documents,
          error: payload.error,
        });
      });
      return () => {
        disposed = true;
        for (const unlisten of unlisteners) unlisten();
      };
    },
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

    async captureUrl(annotationId) {
      const path = await invoke<string | null>('capture_path', { annotationId });
      return path === null ? null : convertFileSrc(path);
    },

    getReadingPreferences: () => invoke<ReadingPreferences>('get_reading_preferences'),
    saveReadingPreferences: (preferences) =>
      invoke<ReadingPreferences>('save_reading_preferences', { preferences }),

    listBookmarks: () => invoke<Bookmark[]>('list_bookmarks'),
    createBookmark: (input) => invoke<Bookmark>('create_bookmark', { input }),
    deleteBookmark: (bookmarkId) => invoke('delete_bookmark', { bookmarkId }),

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
