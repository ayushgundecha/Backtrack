import { describe, expect, it } from 'vitest';
import { errorResponse, errorText } from '../lib/server';

describe('error messages for the panel', () => {
  it('never answers a blank message, even for a refused connection', async () => {
    // What a refused TCP connect looks like from Node: an AggregateError with no message.
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6390'), {
      code: 'ECONNREFUSED',
    });
    const both = new AggregateError([refused, new Error('connect ECONNREFUSED ::1:6390')], '');
    expect(errorText(both)).toBe(
      'connect ECONNREFUSED 127.0.0.1:6390; connect ECONNREFUSED ::1:6390',
    );
    expect(errorText(Object.assign(new Error(''), { code: 'ETIMEDOUT' }))).toBe('Error: ETIMEDOUT');
    expect(errorText('plain')).toBe('plain');

    const res = errorResponse(both);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'connect ECONNREFUSED 127.0.0.1:6390; connect ECONNREFUSED ::1:6390',
    });
  });
});
