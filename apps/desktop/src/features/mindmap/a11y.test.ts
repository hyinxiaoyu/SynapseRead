import { describe, expect, it } from 'vitest';

import { cardAriaLabel, edgeAriaLabel, mindMapAriaLabelConfig } from '@/features/mindmap/a11y';
import type { NoteCard } from '@/types/domain';

const baseCard = (overrides: Partial<NoteCard> = {}): NoteCard => ({
  id: 'card-uuid-1234',
  notebookId: 'nb-1',
  title: 'The quick brown fox',
  markdownNotes: '',
  tags: [],
  annotationIds: ['ann-1'],
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('MindMap accessibility helpers (#185)', () => {
  describe('cardAriaLabel', () => {
    it('builds a concise label from title, source, nesting, notes, and tags without IDs', () => {
      const label = cardAriaLabel({
        card: baseCard({
          markdownNotes: '**Key point**: foxes are quick.',
          tags: ['animals', 'speed'],
        }),
        parentTitle: 'Habits',
        sourceLabel: 'sample · Line 6',
      });

      expect(label).toBe(
        'Card: The quick brown fox, from sample · Line 6, nested under ‘Habits’, has notes, 2 tags',
      );
      expect(label).not.toContain('card-uuid-1234');
      expect(label).not.toContain('ann-1');
    });

    it('uses singular tag grammar and reports source removed when no annotations remain', () => {
      const label = cardAriaLabel({
        card: baseCard({
          annotationIds: [],
          tags: ['solo'],
        }),
      });

      expect(label).toBe('Card: The quick brown fox, source removed, 1 tag');
    });

    it('falls back to Untitled card for missing or blank titles and truncates long titles', () => {
      expect(cardAriaLabel({ card: undefined })).toBe('Card: Untitled card');
      expect(cardAriaLabel({ card: baseCard({ title: '   \n\t ' }) })).toBe('Card: Untitled card');

      const longTitle = 'A'.repeat(100);
      const label = cardAriaLabel({ card: baseCard({ title: longTitle }) });
      expect(label).toBe(`Card: ${'A'.repeat(79)}…`);
    });

    it('ignores markdown punctuation when checking whether a card has notes', () => {
      const label = cardAriaLabel({
        card: baseCard({ markdownNotes: '   ###   \n  **  **  ' }),
        sourceLabel: 'book · p. 2',
      });

      expect(label).toBe('Card: The quick brown fox, from book · p. 2');
    });
  });

  describe('edgeAriaLabel', () => {
    it('names nesting links and cross-links from card titles', () => {
      expect(
        edgeAriaLabel({
          sourceTitle: 'Habits',
          targetTitle: 'Cue and routine',
          isNesting: true,
        }),
      ).toBe('‘Cue and routine’ nested under ‘Habits’');

      expect(
        edgeAriaLabel({
          sourceTitle: 'Habits',
          targetTitle: 'Memory',
          isNesting: false,
        }),
      ).toBe('Link from ‘Habits’ to ‘Memory’');
    });

    it('includes optional link labels and falls back safely for missing titles', () => {
      expect(
        edgeAriaLabel({
          sourceTitle: 'A',
          targetTitle: 'B',
          isNesting: true,
          label: 'supports',
        }),
      ).toBe('‘B’ nested under ‘A’ (supports)');

      expect(
        edgeAriaLabel({
          sourceTitle: null,
          targetTitle: '  ',
          isNesting: false,
          label: 'contrasts',
        }),
      ).toBe('Link from ‘Untitled card’ to ‘Untitled card’: contrasts');
    });
  });

  describe('mindMapAriaLabelConfig', () => {
    it('builds macOS node and edge descriptions from commands.json and drops live coordinates', () => {
      const config = mindMapAriaLabelConfig('mac');
      const nodeDesc = config['node.a11yDescription.default'];
      expect(nodeDesc).toBe(config['node.a11yDescription.keyboardDisabled']);
      expect(nodeDesc).toContain('Return to edit card');
      expect(nodeDesc).toContain(
        'Space to select this card and make it the target for the next excerpt',
      );
      expect(nodeDesc).toContain('Once selected, use the arrow keys to move it');
      expect(nodeDesc).toContain('Shift for larger steps');
      expect(nodeDesc).toContain('Delete or Forward Delete to delete it');
      expect(nodeDesc).toContain('Command+Z to undo');
      expect(nodeDesc).toContain('Escape to clear selection');

      const edgeDesc = config['edge.a11yDescription.default'];
      expect(edgeDesc).toContain('Return or Space to select this link');
      expect(edgeDesc).toContain('Delete or Forward Delete to remove it');
      expect(edgeDesc).toContain('Escape to deselect');

      const live = config['node.a11yDescription.ariaLiveMessage']?.({
        direction: 'down',
        x: 40,
        y: 60,
      });
      expect(live).toBe('Moved selected card down.');
      expect(live).not.toContain('40');
      expect(live).not.toContain('60');
    });

    it('uses platform-appropriate key names off macOS', () => {
      const config = mindMapAriaLabelConfig('other');
      const nodeDesc = config['node.a11yDescription.default'];
      expect(nodeDesc).toContain('Enter to edit card');
      expect(nodeDesc).toContain('Backspace or Delete to delete it');
      expect(nodeDesc).toContain('Control+Z to undo');
    });
  });
});
