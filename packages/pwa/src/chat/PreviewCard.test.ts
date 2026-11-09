import { describe, expect, it } from 'vitest';
import { validatedPreviewUrl } from './PreviewCard.js';

const API = 'https://synthetic-pc.example.ts.net';

describe('preview navigation boundary', () => {
  it('accepts a separate HTTPS gateway on this PC and local loopback gateways', () => {
    const gateway = `${API}:8443/#single-use-synthetic-ticket`;
    expect(validatedPreviewUrl(gateway, API)).toBe(gateway);
    expect(validatedPreviewUrl('http://127.0.0.1:7778/#ticket', 'http://127.0.0.1:7777')).toBe('http://127.0.0.1:7778/#ticket');
    expect(validatedPreviewUrl('http://127.0.0.1:7778/#ticket', 'http://[::1]:7777')).toBe('http://127.0.0.1:7778/#ticket');
  });

  it.each([
    `${API}/#ticket`,
    `${API}:9443/#ticket`,
    'https://other-pc.example.ts.net:8443/#ticket',
    'http://synthetic-pc.example.ts.net:8443/#ticket',
    'https://synthetic-pc.example.ts.net.evil.example:8443/#ticket',
    'https://user:secret@synthetic-pc.example.ts.net:8443/#ticket',
    'http://192.168.1.1:7778/#ticket',
    'http://127.0.0.1:7778/#ticket',
    'http://localhost:7778/#ticket',
    'javascript:alert(1)',
    '//synthetic-pc.example.ts.net:8443/#ticket',
    '/api/sessions',
  ])('rejects an untrusted, same-origin or credential-bearing target: %s', (value) => {
    expect(validatedPreviewUrl(value, API)).toBeNull();
  });

  it('rejects even a loopback gateway if it is the API origin', () => {
    expect(validatedPreviewUrl('http://127.0.0.1:7777/#ticket', 'http://127.0.0.1:7777')).toBeNull();
    expect(validatedPreviewUrl(`${API}:8443/#ticket`, `${API}:8443`)).toBeNull();
    expect(validatedPreviewUrl('http://127.0.0.1:7779/#ticket', 'http://127.0.0.1:7777')).toBeNull();
    expect(validatedPreviewUrl('http://localhost:7778/#ticket', 'http://127.0.0.1:7777')).toBeNull();
  });
});
