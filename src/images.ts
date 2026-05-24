// Card image loader.
//
// Strategy: pre-fetch all images referenced by the loaded card set ONCE,
// inline content into a cache, then render functions look them up
// synchronously. No DOM mutation in the reviewer, no MIME guessing per render,
// no flicker.
//
// SVGs are inlined as raw <svg>...</svg> markup so they scale with the page,
// pick up font styles, and don't need Content-Type negotiation with GitHub.
// Raster formats become base64 data: URLs with an explicit MIME.

import type { Card, CardSource } from './cards';

const IMAGE_REF_RE = /!\[[^\]]*\]\(([^)]+)\)/g;

export type ImageContent =
  | { kind: 'svg'; markup: string }
  | { kind: 'data-url'; url: string }
  | { kind: 'error'; message: string };

const cache = new Map<string, ImageContent>(); // path -> content

function isRemote(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

export function collectImagePaths(cards: Card[]): string[] {
  const paths = new Set<string>();
  for (const c of cards) {
    for (const text of [c.front, c.back, c.extra]) {
      if (!text) continue;
      IMAGE_REF_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMAGE_REF_RE.exec(text)) !== null) {
        const path = m[1];
        if (!isRemote(path)) paths.add(path);
      }
    }
  }
  return Array.from(paths);
}

export async function preloadImagesForCards(token: string, src: CardSource, cards: Card[]): Promise<void> {
  const paths = collectImagePaths(cards).filter((p) => !cache.has(p));
  if (paths.length === 0) return;
  await Promise.all(paths.map(async (path) => {
    cache.set(path, await fetchImage(token, src, path));
  }));
}

export function getImageContent(path: string): ImageContent | undefined {
  if (isRemote(path)) return undefined; // caller renders <img src="..."> directly
  return cache.get(path);
}

function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    case 'avif': return 'image/avif';
    default:     return 'application/octet-stream';
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function fetchImage(token: string, src: CardSource, path: string): Promise<ImageContent> {
  const url = `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${encodeURIPath(path)}?ref=${encodeURIComponent(src.branch)}`;
  let r: Response;
  try {
    r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    return { kind: 'error', message: `network: ${(e as Error).message}` };
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { kind: 'error', message: `${r.status} ${body.slice(0, 100)}` };
  }

  const mime = guessMime(path);
  if (mime === 'image/svg+xml') {
    let text = await r.text();
    // Strip XML processing instruction; <svg> alone embeds fine.
    text = text.replace(/<\?xml[^?]*\?>\s*/, '');
    return { kind: 'svg', markup: text };
  }
  const buf = await r.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  return { kind: 'data-url', url: `data:${mime};base64,${b64}` };
}

function encodeURIPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function clearImageCache(): void {
  cache.clear();
}
