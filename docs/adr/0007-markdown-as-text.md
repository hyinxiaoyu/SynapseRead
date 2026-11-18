# ADR 0007: Markdown opens as text until the Markdown reader

**Status:** Accepted for issue #99. Revisit when the V1.1 Markdown reader starts.

## Context

The native picker offered `.md` and `.markdown`, and the drop overlay promised Markdown,
but those files registered as `md`, a format with no engine. Each one opened as a tab
that said only "Markdown support arrives in V1.1", and it stayed in the documents table,
Recent documents, and the restored session. The empty state, meanwhile, named only PDF,
EPUB, and TXT.

Markdown is UTF-8 text, and the TXT engine already streams, virtualizes, searches, and
anchors text, so it can read Markdown files today, showing the source rather than
rendered output. The alternative was to stop offering Markdown and decline it on drop
until V1.1.

## Decision

**Markdown files register as `txt` and open in the TXT engine.**

- `DocumentFormat::from_extension` maps `md` and `markdown` to `Txt`. Nothing produces
  `DocumentFormat::Md` or a `MarkdownAnchor`. Both stay reserved, unchanged, so the IPC
  contract and `anchors.json` do not change.
- `fixtures/contract/document-formats.json` lists the openable formats with a label and
  their extensions. Core tests that it equals `DocumentFormat::EXTENSIONS` (the picker
  filter) and that each extension registers as the stated format. The frontend builds
  the drop overlay and empty-state copy from the same labels, so all three name the same
  set. Recent documents label a document by its file's extension, so a Markdown file
  still says Markdown.
- Migration 0013 turns existing `md` documents into `txt`. Registration matches a known
  file by content hash and keeps its stored format, so without the migration a file first
  opened before this change would still be a dead end. A document holding `md`
  annotations or bookmarks stays `md`, because core rejects `md` anchors on a `txt`
  document. No reader ever produced one, so this is a guard, not a known case.
- The relink picker filters by every extension of the document's format
  (`DocumentFormat::extensions`), not only its name, so a Markdown document can be
  relinked to a `.md` file.

## Consequences for anchors and the Markdown reader

Excerpts, highlights, bookmarks, and saved positions in Markdown files are `TxtAnchor`
byte ranges into the source file, with the guarantees of ADR 0002. The V1.1 reader must
decide what happens to them. The options, from least to most work:

1. **Leave existing documents as `txt`.** Only files registered after the reader ships
   become `md`. This is simple, but registration finds a known file by hash and keeps
   its format, so a Markdown file first opened in V1.0 never gets the new reader unless
   it is migrated.
2. **Make `MarkdownAnchor` address source bytes too.** The reserved shape
   (`astNodeId` and `offset`) has never been written, so it can still change. If it
   carries `startByteOffset` and `endByteOffset`, with the AST node only as a hint,
   migrating is a relabel: change `documents.format` and `anchor_type` to `md` and
   rewrite each payload's `format` field. Byte offsets survive re-parsing, as they
   survive re-chunking for TXT, and the parser's source positions map them to nodes.
3. **Keep the AST-node shape and convert.** Parse each file, map each TXT byte range to
   the node that contains it, and rewrite the anchor. This needs the file on disk and
   unchanged (`file_hash` must match). Ranges that cross block boundaries have no single
   node, and anchors in missing or edited files cannot be converted. Those would have to
   stay `txt`, so core would then need to accept both anchor kinds on `md` documents.

Option 2 is recommended. It keeps one addressing scheme for text formats and makes the
migration a single transaction with no file access. Whichever option is chosen, its
migration is a new file. It must leave every `txt` document without a `.md` or
`.markdown` path untouched, and keep annotations attached through `card_annotations`.

Until then, the `md` arm of `viewerRegistry` keeps `UnsupportedFormatViewer`. Only a
legacy `md` document holding Markdown anchors can reach it.
