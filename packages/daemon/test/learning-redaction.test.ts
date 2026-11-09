import { describe, expect, it } from 'vitest';
import { containsLearningSecret, learningEnvironmentSecrets, redactLearningSecrets } from '../src/learning-redaction.js';

describe('learning credential heuristics', () => {
  it.each([
    'api_key=sk-synthetic12345678901234567890',
    'Authorization: Bearer syntheticcredential1234567890',
    'password="synthetic-password"',
    'https://synthetic:password@example.invalid/path',
    '-----BEGIN PRIVATE KEY-----\nsynthetic material\n-----END PRIVATE KEY-----',
    'ghp_synthetic1234567890123456789012345',
    'eyJsyntheticvalue.eyJsyntheticvalue.syntheticsignature',
  ])('recognizes and redacts common credentials without retaining raw material', (text) => {
    expect(containsLearningSecret(text)).toBe(true);
    expect(redactLearningSecrets(text)).toContain('[REDACTED]');
    expect(containsLearningSecret(redactLearningSecrets(text))).toBe(false);
  });

  it('redacts known configured credential values even without a recognizable token prefix', () => {
    const secrets = learningEnvironmentSecrets({ SERVICE_API_KEY: 'synthetic-unprefixed-value', NORMAL_SETTING: 'retain-this' });
    expect(secrets).toEqual(['synthetic-unprefixed-value']);
    expect(redactLearningSecrets('Unlabelled synthetic-unprefixed-value and retain-this', secrets)).toBe('Unlabelled [REDACTED] and retain-this');
  });

  it('preserves ordinary procedural advice and documents the heuristic boundary', () => {
    const text = 'Use npm for tests. Never store passwords in project files.';
    expect(containsLearningSecret(text)).toBe(false);
    expect(redactLearningSecrets(text)).toBe(text);
    // An unlabelled, novel opaque secret is not recognizable without a known configured value.
    expect(containsLearningSecret('unlabelled-opaque-synthetic-value')).toBe(false);
  });
});
