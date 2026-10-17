/** The evidence of one query call, in the shape the UI's trace strip shows. */
import type { QueryResult } from '../contracts/types.js';

export interface QueryTrace {
  /** Query id from queries.ts (Q1…, R3…), so the UI can name the query behind a number. */
  query: string;
  cypher: string;
  ms: number;
  rows: number;
}

export function traceOf(query: string, res: QueryResult<unknown>): QueryTrace {
  return { query, cypher: res.cypher, ms: res.ms, rows: res.rows.length };
}
