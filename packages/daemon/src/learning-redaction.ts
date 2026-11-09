// Heuristics, not a disclosure guarantee: unlabelled, novel, split, or encoded secrets can evade detection.
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/g,
  /\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|credential|token)\b["']?\s*[:=]\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;}{\[\]\r\n]{4,})/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export function containsLearningSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function redactLearningSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of extraSecrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join('[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

export function learningEnvironmentSecrets(env: Readonly<NodeJS.ProcessEnv>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /(?:key|token|secret|password|credential|authorization)/i.test(key) && value !== undefined && value.length >= 4)
    .map(([, value]) => value as string);
}
