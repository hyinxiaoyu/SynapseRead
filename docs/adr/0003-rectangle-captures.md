# ADR 0003: Rectangle captures

**Status:** Accepted for M2.

## Context

The roadmap proposes storing captures in the app-data directory keyed by annotation
id. That does not fit the current data flow: `ReaderSelection.imagePath` must exist at
selection time, but the annotation id is generated later, inside `create_excerpt`.
Separately, `excerpt_image_path` is a webview-supplied path in the input; with the
asset scope granting captures, it must not become a way to name arbitrary files.

## Decision

**Location:** `<app-data>/captures/<annotation-id>.png`. The database stores the
relative path `captures/<annotation-id>.png`, so moving the app-data directory does not
break it.

**Writer:** `synapse-core`, inside `create_excerpt`.

1. The reader crops the page canvas to a PNG and holds it in `ReaderSelection.imagePng`
   (base64). Nothing touches the disk at selection time.
2. `CreateExcerptInput.excerptImagePath` is replaced by `excerptImagePng`. The webview
   can no longer supply a path.
3. Core validates the PNG signature and a size cap (`invalid_capture`), generates the
   annotation id, writes through a temporary file and rename, then commits the
   transaction. Any failure removes the file.

**Reading:** the `captures/` directory, non-recursively, joins the asset scope through
the grant function from [ADR 0001](0001-path-scope.md). The SQLite database next to it
stays out of scope. `StudyBackend.captureUrl` resolves an annotation to a URL.

## Tradeoffs

- Accepted: base64 costs 33% on the wire, and a pending capture sits in memory until it
  is excerpted or replaced. Captures are typically far below the size cap.
- Accepted: the database lock is held across one small file write.
- Accepted: a crash between rename and commit leaves an orphan file. It is harmless,
  and the id in its name makes it detectable by a sweep.
- Handed to M3: deleting annotations or notebooks must delete capture files. Today
  nothing deletes either, but the notebook cascade will need an explicit step.

**Alternatives rejected:** a `save_capture` command at selection time (every abandoned
selection leaves an orphan, and the name cannot be the annotation id); a webview write
via the fs plugin (a broad new capability); BLOBs in SQLite (bloats the database, and
the column already specifies a path).

## What would reverse this

- Captures large enough for base64 to hurt: switch to Tauri's raw binary IPC body, with
  the same layer and location.
- Annotation merges or sync that share one image: move to content-addressed filenames.
