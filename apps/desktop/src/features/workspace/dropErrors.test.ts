import { describe, expect, it } from 'vitest';

import { SUPPORTED_FORMAT_CONJUNCTION } from '@/lib/documentFormats';

import { formatDropErrors } from './dropErrors';

describe('formatDropErrors (#130)', () => {
  it('returns null when there are no failures', () => {
    expect(formatDropErrors([])).toBeNull();
  });

  it('names a single unsupported file and lists supported formats from document-formats.json', () => {
    expect(
      formatDropErrors([
        {
          fileName: 'archive.zip',
          code: 'unsupported_format',
          message: 'unsupported document format: zip',
        },
      ]),
    ).toBe(`Couldn't open archive.zip. SynapseRead opens ${SUPPORTED_FORMAT_CONJUNCTION}.`);
  });

  it('names up to three unsupported files and summarizes the rest as (+k more)', () => {
    expect(
      formatDropErrors([
        { fileName: 'Thesis draft.docx', code: 'unsupported_format', message: 'raw' },
        { fileName: 'Reading log.xlsx', code: 'unsupported_format', message: 'raw' },
        { fileName: 'Scan.jpg', code: 'unsupported_format', message: 'raw' },
      ]),
    ).toBe(
      `Couldn't open 3 files: Thesis draft.docx, Reading log.xlsx, Scan.jpg. SynapseRead opens ${SUPPORTED_FORMAT_CONJUNCTION}.`,
    );

    expect(
      formatDropErrors([
        { fileName: 'a.docx', code: 'unsupported_format', message: 'raw' },
        { fileName: 'b.xlsx', code: 'unsupported_format', message: 'raw' },
        { fileName: 'c.jpg', code: 'unsupported_format', message: 'raw' },
        { fileName: 'd.pptx', code: 'unsupported_format', message: 'raw' },
        { fileName: 'e.png', code: 'unsupported_format', message: 'raw' },
      ]),
    ).toBe(
      `Couldn't open 5 files: a.docx, b.xlsx, c.jpg (+2 more). SynapseRead opens ${SUPPORTED_FORMAT_CONJUNCTION}.`,
    );
  });

  it('gives dropped folders their own message without an empty format name', () => {
    const single = formatDropErrors([
      {
        fileName: 'Course readings',
        code: 'is_directory',
        message: 'directories cannot be opened',
      },
    ]);
    expect(single).toBe(
      "Couldn't open folder Course readings. Folders can't be opened; drop the files inside.",
    );
    expect(single).not.toContain('unsupported document format');

    const multi = formatDropErrors([
      { fileName: 'Readings', code: 'is_directory', message: 'dir' },
      { fileName: 'Slides', code: 'is_directory', message: 'dir' },
    ]);
    expect(multi).toBe(
      "Couldn't open 2 folders: Readings, Slides. Folders can't be opened; drop the files inside.",
    );
  });

  it('combines unsupported files and dropped folders in the same drop', () => {
    const message = formatDropErrors([
      { fileName: 'Thesis draft.docx', code: 'unsupported_format', message: 'raw' },
      { fileName: 'Course readings', code: 'is_directory', message: 'dir' },
    ]);
    expect(message).toBe(
      `Couldn't open Thesis draft.docx. SynapseRead opens ${SUPPORTED_FORMAT_CONJUNCTION}. Couldn't open folder Course readings. Folders can't be opened; drop the files inside.`,
    );
  });

  it('handles unreadable I/O errors with a reader-facing message', () => {
    expect(
      formatDropErrors([{ fileName: 'locked.pdf', code: 'io', message: 'permission denied' }]),
    ).toBe("Couldn't open locked.pdf. Check that the file is readable and try again.");
  });
});
