// Session-log writer: one DraftIssue per study session in `anki-client/session-log`.

import { gql } from './gh';
import type { FieldMap } from './srsState';

export interface SessionSummary {
  date: Date;
  reviews: number;
  newCards: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  retentionPct: number;
  timeMin: number;
  notes?: string;
}

const ADD_DRAFT = `
  mutation($projectId: ID!, $title: String!, $body: String!) {
    addProjectV2DraftIssue(input: {projectId: $projectId, title: $title, body: $body}) {
      projectItem { id }
    }
  }
`;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function writeSession(
  token: string,
  projectId: string,
  fields: FieldMap,
  summary: SessionSummary,
): Promise<string> {
  const title = `${isoDate(summary.date)} — ${summary.reviews} reviews · ${summary.retentionPct}% retention`;
  const body = [
    `**Date**: ${isoDate(summary.date)}`,
    `**Reviews**: ${summary.reviews} (new: ${summary.newCards})`,
    `**Again** ${summary.again} · **Hard** ${summary.hard} · **Good** ${summary.good} · **Easy** ${summary.easy}`,
    `**Retention**: ${summary.retentionPct}%`,
    `**Time**: ${summary.timeMin} min`,
    summary.notes ? `\n**Notes**\n\n${summary.notes}` : '',
  ].join('\n');

  const created = await gql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(token, ADD_DRAFT, {
    projectId,
    title,
    body,
  });
  const itemId = created.addProjectV2DraftIssue.projectItem.id;

  const parts: string[] = [];
  const vars: Record<string, unknown> = { projectId, itemId };

  function alias(alias: string, fieldName: string, valueLiteral: string): void {
    const fr = fields[fieldName];
    if (!fr) return;
    parts.push(`${alias}: updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: "${fr.id}", value: ${valueLiteral}
    }) { projectV2Item { id } }`);
  }

  alias('a_date', 'Date', `{ date: "${isoDate(summary.date)}" }`);
  alias('a_reviews', 'Reviews', `{ number: ${summary.reviews} }`);
  alias('a_new', 'New cards', `{ number: ${summary.newCards} }`);
  alias('a_again', 'Again', `{ number: ${summary.again} }`);
  alias('a_hard', 'Hard', `{ number: ${summary.hard} }`);
  alias('a_good', 'Good', `{ number: ${summary.good} }`);
  alias('a_easy', 'Easy', `{ number: ${summary.easy} }`);
  alias('a_retention', 'Retention %', `{ number: ${summary.retentionPct} }`);
  alias('a_time', 'Time (min)', `{ number: ${summary.timeMin} }`);
  if (summary.notes) {
    alias('a_notes', 'Notes', `{ text: "${escapeStr(summary.notes)}" }`);
  }

  if (parts.length > 0) {
    const mutation = `mutation($projectId: ID!, $itemId: ID!) { ${parts.join('\n')} }`;
    await gql(token, mutation, vars);
  }

  return itemId;
}
