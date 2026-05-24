// Tiny GraphQL helper for api.github.com.

export interface GraphQLError {
  message: string;
  type?: string;
  path?: (string | number)[];
}

export class GitHubError extends Error {
  constructor(public status: number, public errors?: GraphQLError[], public raw?: unknown) {
    super(`GitHub ${status}: ${errors?.map((e) => e.message).join('; ') ?? 'unknown'}`);
  }
}

export async function gql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (!r.ok || body.errors) {
    throw new GitHubError(r.status, body.errors, body);
  }
  return body.data as T;
}
