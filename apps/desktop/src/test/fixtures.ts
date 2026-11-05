/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Reads a binary file from `fixtures/documents`; tests run under Node. */
export function documentFixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(resolve(import.meta.dirname, '../../../../fixtures/documents', name)),
  );
}
