// Card image loader. Images live in the same private repo as the cards
// (e.g. `images/foo.svg` at the repo root). They can't be embedded via raw
// <img src> for private repos because raw.githubusercontent.com would need
// the bearer token in the URL. Instead, we fetch via the Contents API,
// turn the response into a blob, and hand back an `objectURL` for the <img>.

import type { CardSource } from './cards';

const cache = new Map<string, string>(); // path key -> blob URL

function cacheKey(src: CardSource, path: string): string {
  return `${src.owner}/${src.repo}@${src.branch}:${path}`;
}

export async function loadImage(token: string, src: CardSource, path: string): Promise<string> {
  const key = cacheKey(src, path);
  const hit = cache.get(key);
  if (hit) return hit;

  const url = `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${encodeURIPath(path)}?ref=${encodeURIComponent(src.branch)}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) throw new Error(`image ${path}: ${r.status}`);
  const blob = await r.blob();
  const objUrl = URL.createObjectURL(blob);
  cache.set(key, objUrl);
  return objUrl;
}

function encodeURIPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Drop cached blob URLs (e.g. on sign-out) to free memory. */
export function clearImageCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
}
