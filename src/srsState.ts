// Per-card SRS state, persisted as one ProjectV2 Item per card in the
// `anki-client/srs-state` project. Items are created lazily on first review.
//
// Field mapping (see SYNC-DESIGN §11.1):
//   GUID          (TEXT)           — lookup key
//   State         (SINGLE_SELECT)  — new / learning / review / relearning / suspended
//   Due           (DATE)
//   Stability     (NUMBER)
//   Difficulty    (NUMBER)
//   Reps          (NUMBER)
//   Lapses        (NUMBER)
//   Last reviewed (DATE)
//   Deck          (SINGLE_SELECT)  — left at "unassigned" for now (real decks become options later)

import { gql } from './gh';
import { freshState, State, type FSRSCardState } from './fsrs';
import type { Card } from './cards';

export interface FieldRef {
  id: string;
  dataType: string;
  options?: Record<string, string>; // name -> optionId
}

export type FieldMap = Record<string, FieldRef>;

export interface SrsItem {
  itemId: string;
  state: FSRSCardState;
}

const FIELDS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 30) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField {
              id name dataType
              options { id name }
            }
          }
        }
      }
    }
  }
`;

export async function discoverFields(token: string, projectId: string): Promise<FieldMap> {
  const data = await gql<{
    node: { fields: { nodes: Array<{ id?: string; name?: string; dataType?: string; options?: Array<{ id: string; name: string }> }> } };
  }>(token, FIELDS_QUERY, { projectId });
  const out: FieldMap = {};
  for (const f of data.node.fields.nodes) {
    if (!f.id || !f.name || !f.dataType) continue;
    const ref: FieldRef = { id: f.id, dataType: f.dataType };
    if (f.options) {
      ref.options = {};
      for (const o of f.options) ref.options[o.name] = o.id;
    }
    out[f.name] = ref;
  }
  return out;
}

const ITEMS_QUERY = `
  query($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface ItemNode {
  id: string;
  fieldValues: {
    nodes: Array<{
      __typename: string;
      text?: string;
      date?: string;
      number?: number;
      name?: string;
      field?: { name?: string };
    }>;
  };
}

export async function loadAllItems(token: string, projectId: string): Promise<Map<string, SrsItem>> {
  const byGuid = new Map<string, SrsItem>();
  let cursor: string | null = null;
  while (true) {
    const data: any = await gql(token, ITEMS_QUERY, { projectId, cursor });
    const items: ItemNode[] = data.node.items.nodes;
    for (const it of items) {
      const fields: Record<string, string | number | undefined> = {};
      for (const fv of it.fieldValues.nodes) {
        const fname = fv.field?.name;
        if (!fname) continue;
        if (fv.__typename === 'ProjectV2ItemFieldTextValue') fields[fname] = fv.text;
        else if (fv.__typename === 'ProjectV2ItemFieldDateValue') fields[fname] = fv.date;
        else if (fv.__typename === 'ProjectV2ItemFieldNumberValue') fields[fname] = fv.number;
        else if (fv.__typename === 'ProjectV2ItemFieldSingleSelectValue') fields[fname] = fv.name;
      }
      const guid = typeof fields['GUID'] === 'string' ? (fields['GUID'] as string) : undefined;
      if (!guid) continue;
      byGuid.set(guid, { itemId: it.id, state: itemFieldsToState(fields) });
    }
    if (!data.node.items.pageInfo.hasNextPage) break;
    cursor = data.node.items.pageInfo.endCursor;
  }
  return byGuid;
}

function itemFieldsToState(f: Record<string, string | number | undefined>): FSRSCardState {
  const base = freshState();
  const stateName = typeof f['State'] === 'string' ? (f['State'] as string) : 'new';
  base.state =
    stateName === 'learning' ? State.Learning
    : stateName === 'review' ? State.Review
    : stateName === 'relearning' ? State.Relearning
    : State.New;
  if (typeof f['Due'] === 'string') base.due = new Date(f['Due'] as string);
  if (typeof f['Last reviewed'] === 'string') base.last_review = new Date(f['Last reviewed'] as string);
  if (typeof f['Stability'] === 'number') base.stability = f['Stability'] as number;
  if (typeof f['Difficulty'] === 'number') base.difficulty = f['Difficulty'] as number;
  if (typeof f['Reps'] === 'number') base.reps = f['Reps'] as number;
  if (typeof f['Lapses'] === 'number') base.lapses = f['Lapses'] as number;
  return base;
}

function stateToOptionName(s: State): string {
  switch (s) {
    case State.Learning: return 'learning';
    case State.Review: return 'review';
    case State.Relearning: return 'relearning';
    default: return 'new';
  }
}

function isoDate(d: Date): string {
  // Project Date fields expect YYYY-MM-DD.
  return d.toISOString().slice(0, 10);
}

const ADD_DRAFT = `
  mutation($projectId: ID!, $title: String!) {
    addProjectV2DraftIssue(input: {projectId: $projectId, title: $title}) {
      projectItem { id }
    }
  }
`;

/**
 * Create a new Project Item for a card and set its initial FSRS fields.
 * Returns the new itemId.
 */
export async function createItem(
  token: string,
  projectId: string,
  fields: FieldMap,
  card: Card,
  fsrsState: FSRSCardState,
): Promise<string> {
  const title = makeTitle(card);
  const created = await gql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(token, ADD_DRAFT, {
    projectId,
    title,
  });
  const itemId = created.addProjectV2DraftIssue.projectItem.id;
  await writeFields(token, projectId, itemId, fields, card.guid, fsrsState);
  return itemId;
}

/** Update an existing Item's FSRS fields. */
export async function updateItem(
  token: string,
  projectId: string,
  itemId: string,
  fields: FieldMap,
  fsrsState: FSRSCardState,
  guid: string,
): Promise<void> {
  await writeFields(token, projectId, itemId, fields, guid, fsrsState);
}

/** Write all FSRS-derived fields in one aliased mutation (single HTTP call). */
async function writeFields(
  token: string,
  projectId: string,
  itemId: string,
  fields: FieldMap,
  guid: string,
  s: FSRSCardState,
): Promise<void> {
  const parts: string[] = [];
  const vars: Record<string, unknown> = { projectId, itemId };

  function alias(alias: string, fieldName: string, valueLiteral: string): void {
    const fr = fields[fieldName];
    if (!fr) return; // skip if project lacks this field
    parts.push(`${alias}: updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: "${fr.id}", value: ${valueLiteral}
    }) { projectV2Item { id } }`);
  }

  alias('a_guid', 'GUID', `{ text: "${escapeStr(guid)}" }`);

  const stateField = fields['State'];
  if (stateField?.options) {
    const optionId = stateField.options[stateToOptionName(s.state)];
    if (optionId) alias('a_state', 'State', `{ singleSelectOptionId: "${optionId}" }`);
  }

  alias('a_due', 'Due', `{ date: "${isoDate(s.due)}" }`);
  alias('a_stability', 'Stability', `{ number: ${s.stability} }`);
  alias('a_difficulty', 'Difficulty', `{ number: ${s.difficulty} }`);
  alias('a_reps', 'Reps', `{ number: ${s.reps} }`);
  alias('a_lapses', 'Lapses', `{ number: ${s.lapses} }`);
  if (s.last_review) {
    alias('a_last', 'Last reviewed', `{ date: "${isoDate(s.last_review)}" }`);
  }

  if (parts.length === 0) return;
  const mutation = `mutation($projectId: ID!, $itemId: ID!) { ${parts.join('\n')} }`;
  await gql(token, mutation, vars);
}

function makeTitle(card: Card): string {
  const deckTail = card.deck.split('::').pop() || card.deck;
  return `${deckTail} · ${card.id}`;
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
