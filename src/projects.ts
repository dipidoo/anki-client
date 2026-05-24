// Project discovery + cached lookup.
//
// At runtime the SPA queries the viewer's ProjectV2 boards, filters by name
// prefix (e.g. "anki-client/"), and dispatches by the captured purpose:
//   "anki-client/srs-state"   -> purpose "srs-state"
//   "anki-client/session-log" -> purpose "session-log"
//
// Result is cached in localStorage keyed by viewer.login so it survives
// reloads but doesn't bleed across accounts on the same browser.

import { gql } from './gh';

export interface DiscoveredProject {
  id: string;
  number: number;
  title: string;
  purpose: string;
  url: string;
}

export interface ProjectMap {
  byPurpose: Record<string, DiscoveredProject>;
  all: DiscoveredProject[];
  fetchedAt: number;
}

const LS_KEY = (viewerLogin: string) => `anki-client:projects:${viewerLogin}`;

interface ProjectsQueryResponse {
  viewer: {
    projectsV2: {
      nodes: { id: string; number: number; title: string; url: string }[];
    };
  };
}

const PROJECTS_QUERY = `
  query {
    viewer {
      projectsV2(first: 100) {
        nodes { id number title url }
      }
    }
  }
`;

export async function discoverProjects(
  token: string,
  prefix: string,
  viewerLogin: string,
): Promise<ProjectMap> {
  const data = await gql<ProjectsQueryResponse>(token, PROJECTS_QUERY);
  const all: DiscoveredProject[] = [];
  for (const node of data.viewer.projectsV2.nodes) {
    if (!node.title.startsWith(prefix)) continue;
    const purpose = node.title.slice(prefix.length);
    if (!purpose) continue;
    all.push({ id: node.id, number: node.number, title: node.title, purpose, url: node.url });
  }
  const byPurpose: Record<string, DiscoveredProject> = {};
  for (const p of all) byPurpose[p.purpose] = p;

  const map: ProjectMap = { byPurpose, all, fetchedAt: Date.now() };
  localStorage.setItem(LS_KEY(viewerLogin), JSON.stringify(map));
  return map;
}

export function loadCachedProjects(viewerLogin: string): ProjectMap | undefined {
  const raw = localStorage.getItem(LS_KEY(viewerLogin));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function clearProjectsCache(viewerLogin: string): void {
  localStorage.removeItem(LS_KEY(viewerLogin));
}
