import { SUPPORTED_FORMAT_CONJUNCTION } from '@/lib/documentFormats';
import type { DroppedDocumentError } from '@/types/domain';

const MAX_NAMED_FILES = 3;

function formatFileNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED_FILES).join(', ');
  const hiddenCount = names.length - MAX_NAMED_FILES;
  return hiddenCount > 0 ? `${shown} (+${hiddenCount} more)` : shown;
}

/**
 * Turns structured drop failures into a concise reader-facing summary, grouping
 * by stable error code so dropped folders and unsupported files never expose
 * raw core error text (#130).
 */
export function formatDropErrors(errors: readonly DroppedDocumentError[]): string | null {
  if (errors.length === 0) return null;

  const unsupported: string[] = [];
  const directories: string[] = [];
  const other: string[] = [];

  for (const error of errors) {
    const name = error.fileName.trim() || 'unnamed file';
    if (error.code === 'is_directory') {
      directories.push(name);
    } else if (error.code === 'unsupported_format') {
      unsupported.push(name);
    } else {
      other.push(name);
    }
  }

  const parts: string[] = [];

  if (unsupported.length > 0) {
    const names = formatFileNames(unsupported);
    const subject = unsupported.length === 1 ? names : `${unsupported.length} files: ${names}`;
    parts.push(`Couldn't open ${subject}. SynapseRead opens ${SUPPORTED_FORMAT_CONJUNCTION}.`);
  }

  if (directories.length > 0) {
    const names = formatFileNames(directories);
    const subject =
      directories.length === 1 ? `folder ${names}` : `${directories.length} folders: ${names}`;
    parts.push(`Couldn't open ${subject}. Folders can't be opened; drop the files inside.`);
  }

  if (other.length > 0) {
    const names = formatFileNames(other);
    const subject = other.length === 1 ? names : `${other.length} files: ${names}`;
    parts.push(
      `Couldn't open ${subject}. Check that ${other.length === 1 ? 'the file is' : 'the files are'} readable and try again.`,
    );
  }

  return parts.join(' ');
}
