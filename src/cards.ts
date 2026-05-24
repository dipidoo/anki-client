// Card loader: fetch YAML files from a private repo via the Contents API,
// parse with js-yaml, merge file-level defaults, derive a stable GUID per card.
//
// GUID derivation:  guid = sha1("agentpd:" + card.id)[:16 hex chars]
// Same slug → same GUID forever. This is the lookup key against the
// anki-client/srs-state Project. NEVER rename a card's `id` — that detaches
// scheduling history.

import { load as parseYaml } from 'js-yaml';

export interface Card {
  id: string;
  guid: string;
  deck: string;
  notetype: 'cloze' | 'basic';
  tags: string[];
  front: string;
  back?: string;
  extra?: string;
  source?: string;
  sourceFile: string; // e.g. "cards/e6717-foundations.yml"
}

export interface CardSource {
  owner: string;
  repo: string;
  branch: string;
  path: string; // e.g. "cards"
}

interface RawCard {
  id?: unknown;
  type?: unknown;
  tags?: unknown;
  front?: unknown;
  back?: unknown;
  extra?: unknown;
  source?: unknown;
}

interface RawCardFile {
  deck?: unknown;
  default_tags?: unknown;
  default_notetype?: unknown;
  source?: unknown;
  cards?: unknown;
}

interface ContentsListItem {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'submodule' | 'symlink';
  sha: string;
  size: number;
  download_url: string | null;
}

/** Load all YAML card files from `src.path` and return a flat list of cards. */
export async function loadAllCards(token: string, src: CardSource): Promise<Card[]> {
  const list = await listCardFiles(token, src);
  const out: Card[] = [];
  for (const file of list) {
    const raw = await fetchFileText(token, src, file.path);
    const parsed = parseFile(raw, file.path);
    for (const c of parsed) out.push(c);
  }
  // Derive GUIDs in parallel (subtle.digest is async).
  await Promise.all(out.map(async (c) => { c.guid = await deriveGuid(c.id); }));
  return out;
}

async function listCardFiles(token: string, src: CardSource): Promise<ContentsListItem[]> {
  const url = contentsUrl(src, src.path);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) throw new Error(`list ${src.path}: ${r.status} ${await r.text()}`);
  const items = (await r.json()) as ContentsListItem[];
  return items.filter((i) => i.type === 'file' && (i.name.endsWith('.yml') || i.name.endsWith('.yaml')));
}

async function fetchFileText(token: string, src: CardSource, path: string): Promise<string> {
  const url = contentsUrl(src, path);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // .raw returns the file body directly — no base64, no JSON envelope.
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) throw new Error(`fetch ${path}: ${r.status} ${await r.text()}`);
  return r.text();
}

function contentsUrl(src: CardSource, path: string): string {
  // ref pinned to the configured branch.
  const params = new URLSearchParams({ ref: src.branch });
  return `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${encodeURIPath(path)}?${params.toString()}`;
}

function encodeURIPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function parseFile(yaml: string, sourceFile: string): Card[] {
  const doc = parseYaml(yaml) as RawCardFile;
  if (!doc || typeof doc !== 'object') throw new Error(`${sourceFile}: empty or non-object`);
  const deck = typeof doc.deck === 'string' ? doc.deck : '';
  if (!deck) throw new Error(`${sourceFile}: missing "deck"`);

  const defaultTags = Array.isArray(doc.default_tags) ? (doc.default_tags as unknown[]).filter(isString) : [];
  const defaultNotetype = doc.default_notetype === 'basic' ? 'basic' : 'cloze';
  const fileSource = typeof doc.source === 'string' ? doc.source : undefined;

  const rawCards = Array.isArray(doc.cards) ? (doc.cards as RawCard[]) : [];
  return rawCards.map((c, i) => {
    if (typeof c.id !== 'string' || !c.id.trim()) {
      throw new Error(`${sourceFile}[#${i}]: missing or invalid "id"`);
    }
    if (typeof c.front !== 'string' || !c.front.trim()) {
      throw new Error(`${sourceFile}[${c.id}]: missing "front"`);
    }
    const tags = Array.isArray(c.tags) ? (c.tags as unknown[]).filter(isString) : [];
    return {
      id: c.id,
      guid: '', // filled async after parse
      deck,
      notetype: c.type === 'basic' ? 'basic' : c.type === 'cloze' ? 'cloze' : defaultNotetype,
      tags: dedupe([...defaultTags, ...tags]),
      front: c.front,
      back: typeof c.back === 'string' ? c.back : undefined,
      extra: typeof c.extra === 'string' ? c.extra : undefined,
      source: typeof c.source === 'string' ? c.source : fileSource,
      sourceFile,
    };
  });
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

/** sha1("agentpd:" + id) truncated to 16 hex chars. */
export async function deriveGuid(id: string): Promise<string> {
  const data = new TextEncoder().encode('agentpd:' + id);
  const hash = await crypto.subtle.digest('SHA-1', data);
  const bytes = new Uint8Array(hash).slice(0, 8);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
