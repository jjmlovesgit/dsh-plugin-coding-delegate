import { describe, expect, it } from 'vitest';
import { extractEgressText } from '../src/delegation';
import { scanDLP } from '../src/index';

/**
 * Tool results are egress.
 *
 * The DLP gate used to scan the prompt `extractPromptText` returned — the last user message — and the
 * host would then re-send the whole conversation, tool output included. A clean prompt says nothing
 * about a tool that just printed a token. These cases are the ones the report called Finding 8.
 */

const session = (messages: unknown[]) => ({ messages });

describe('extractEgressText', () => {
  it('includes tool results, which the prompt extractor ignores', () => {
    const text = extractEgressText(
      session([
        { role: 'user', content: 'implement the thing' },
        { role: 'tool', content: 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE' },
      ])
    );
    expect(text).toContain('implement the thing');
    expect(text).toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('reaches through content blocks and nested output objects', () => {
    const text = extractEgressText(
      session([
        {
          role: 'tool',
          content: [
            { type: 'tool_result', output: { stdout: 'ghp_' + 'a'.repeat(36), stderr: '' } },
          ],
        },
      ])
    );
    expect(text).toContain('ghp_' + 'a'.repeat(36));
  });

  it('serialises a structured result that carries no text field', () => {
    const text = extractEgressText(session([{ role: 'tool', content: { token: 'sk-live-abc123' } }]));
    expect(text).toContain('sk-live-abc123');
  });

  it('leaves ordinary output intact', () => {
    const clean = 'PASS tests/contracts/currency.contract.cjs (12 assertions)';
    const text = extractEgressText(session([{ role: 'tool', content: clean }]));
    expect(text).toBe(clean);
  });
});

describe('the DLP gate sees what the extractor sees', () => {
  it('trips on a credential that only exists in tool output', () => {
    const text = extractEgressText(
      session([{ role: 'tool', content: 'export AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n' }])
    );
    expect(scanDLP(text).hasSensitiveData).toBe(true);
  });

  it('does not trip on a clean tool result', () => {
    const text = extractEgressText(
      session([{ role: 'tool', content: 'ok 1 - currency formats USD as $1.00' }])
    );
    expect(scanDLP(text).hasSensitiveData).toBe(false);
  });
});
