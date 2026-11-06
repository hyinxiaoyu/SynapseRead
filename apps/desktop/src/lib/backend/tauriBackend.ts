import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import type { DroppedDocumentsPayload, StudyBackend } from '@/lib/backend/types';
import { detectPlatform } from '@/lib/platform';
import type {
  Annotation,
  Bookmark,
  CreatedExcerpt,
  DocumentSourceStatus,
  MindMapEdge,
  NoteCard,
  NotebookGraph,
  ReadingPreferences,
  RelinkDocumentResult,
  StudyDocument,
  StudyNotebook,
  TextChunk,
  WorkspaceSession,
} from '@/types/domain';

const DOCUMENTS_DROPPED_EVENT = 'synapse://documents-dropped';
const MENU_COMMAND_EVENT = 'menu-command';

/**
 * `listen` resolves asynchronously; this unsubscribes even when disposed before
 * then, and drops anything delivered in between.
 */
function subscribe(start: (isLive: () => boolean) => Promise<UnlistenFn>): () => void {
  let disposed = false;
  let stop: UnlistenFn | null = null;
  void start(() => !disposed).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  });
  return () => {
    disposed = true;
    stop?.();
  };
}

export function createTauriBackend(): StudyBackend {
  return {
    kind: 'tauri',
    // Only macOS gets the overlay title bar: see `create_main_window` in `lib.rs`.
    chromeStyle: detectPlatform() === 'mac' ? 'overlay' : 'standard',

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
    touchDocumentOpened: (documentId) =>
      invoke<StudyDocument>('touch_document_opened', { documentId }),
    verifyDocumentSource: (documentId) =>
      invoke<DocumentSourceStatus>('verify_document_source', { documentId }),
    relinkDocument: (documentId, confirmInPlace) =>
      invoke<RelinkDocumentResult | null>('relink_document', {
        documentId,
        confirmInPlace: confirmInPlace ?? false,
      }),
    getWorkspaceSession: () => invoke<WorkspaceSession>('get_workspace_session'),
    saveWorkspaceSession: (session) =>
      invoke<WorkspaceSession>('save_workspace_session', { session }),

    createNotebook: (title) => invoke<StudyNotebook>('create_notebook', { title }),
    listNotebooks: () => invoke<StudyNotebook[]>('list_notebooks'),
    saveNotebookViewport: (notebookId, viewport) =>
      invoke('save_notebook_viewport', { notebookId, viewport }),
    loadNotebookGraph: (notebookId) => invoke<NotebookGraph>('load_notebook_graph', { notebookId }),

    createExcerpt: (input) => invoke<CreatedExcerpt>('create_excerpt', { input }),
    createAnnotation: (input) => invoke<Annotation>('create_annotation', { input }),
    updateAnnotation: (annotationId, patch) =>
      invoke<Annotation>('update_annotation', { annotationId, patch }),
    deleteAnnotation: (annotationId) => invoke('delete_annotation', { annotationId }),
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

    onMenuCommand: (listener) =>
      subscribe((isLive) =>
        listen<{ commandId: string }>(MENU_COMMAND_EVENT, (event) => {
          if (isLive()) listener(event.payload.commandId);
        }),
      ),
    setMenuItemStates: (states) => invoke('set_menu_item_states', { states }),
    isFullscreen: () => getCurrentWindow().isFullscreen(),
    setFullscreen: (fullscreen) => getCurrentWindow().setFullscreen(fullscreen),
    onFullscreenChange(listener) {
      const window = getCurrentWindow();
      let last: boolean | null = null;
      // Neither the green button nor Esc reports full screen directly; a resize does.
      return subscribe((isLive) =>
        window.onResized(() => {
          void window.isFullscreen().then((fullscreen) => {
            if (!isLive() || fullscreen === last) return;
            last = fullscreen;
            listener(fullscreen);
          });
        }),
      );
    },

    // The asset protocol enforces its scope in Rust, whatever this URL names.
    loadDocumentSource: async (document) => ({
      kind: 'url',
      url: convertFileSrc(document.filePath),
    }),

    readTextStream(documentId, encoding, onChunk, signal) {
      const streamId = crypto.randomUUID();
      if (signal?.aborted) {
        void invoke<boolean>('cancel_text_stream', { streamId });
        return Promise.resolve(0);
      }
      const onAbort = () => {
        void invoke<boolean>('cancel_text_stream', { streamId });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const channel = new Channel<TextChunk>();
      channel.onmessage = (chunk) => {
        if (!signal?.aborted) onChunk(chunk);
      };
      return invoke<number>('read_text_stream', {
        documentId,
        encoding,
        streamId,
        onChunk: channel,
      }).finally(() => {
        signal?.removeEventListener('abort', onAbort);
      });
    },
  };
}
