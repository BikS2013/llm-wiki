import { pageExists, writePage, type WikiPaths } from '../wiki/layout.js';
import { WikiLayoutError } from '../errors.js';

export function writePageFile(paths: WikiPaths, id: string, content: string): string {
  return writePage(paths, id, content);
}

/** Picks an unused page id `folder/slug`, `folder/slug-2`, ... */
export function freePageId(paths: WikiPaths, folder: string, slug: string): string {
  const base = `${folder}/${slug}`;
  if (!pageExists(paths, base)) return base;
  for (let i = 2; i < 1000; i++) if (!pageExists(paths, `${base}-${i}`)) return `${base}-${i}`;
  throw new WikiLayoutError(`Could not find a free page id for ${base}.`);
}
