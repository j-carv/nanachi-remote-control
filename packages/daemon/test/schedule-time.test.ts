import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api-error.js';
import { nextScheduleRun, previewScheduleRuns } from '../src/schedule-time.js';

const epoch = (value: string): number => Date.parse(value);

describe('workspace cron calendars', () => {
  it('uses the saved timezone instead of the daemon timezone', () => {
    expect(nextScheduleRun('0 9 * * *', 'America/Sao_Paulo', epoch('2026-11-10T10:00:00Z')))
      .toBe(epoch('2026-11-10T12:00:00Z'));
    expect(nextScheduleRun('0 9 * * *', 'Asia/Tokyo', epoch('2026-11-10T10:00:00Z')))
      .toBe(epoch('2026-11-11T00:00:00Z'));
  });

  it('preserves local wall time across both daylight-saving changes', () => {
    expect(nextScheduleRun('0 9 * * *', 'America/New_York', epoch('2026-03-07T15:00:00Z')))
      .toBe(epoch('2026-03-08T13:00:00Z'));
    expect(nextScheduleRun('0 9 * * *', 'America/New_York', epoch('2026-10-31T15:00:00Z')))
      .toBe(epoch('2026-11-01T14:00:00Z'));
  });

  it('finds leap days without skipping the next valid year', () => {
    expect(nextScheduleRun('0 9 29 2 *', 'UTC', epoch('2027-01-01T00:00:00Z')))
      .toBe(epoch('2028-02-29T09:00:00Z'));
  });

  it('uses standard OR semantics for day-of-month and day-of-week', () => {
    expect(nextScheduleRun('0 0 1 * MON', 'UTC', epoch('2026-01-02T00:00:00Z')))
      .toBe(epoch('2026-01-05T00:00:00Z'));
  });

  it('previews five strictly future dates, including when a boundary is exactly now', () => {
    expect(previewScheduleRuns('*/15 * * * *', 'UTC', epoch('2026-11-10T12:00:00Z'))).toEqual([
      '2026-11-10T12:15:00Z', '2026-11-10T12:30:00Z', '2026-11-10T12:45:00Z',
      '2026-11-10T13:00:00Z', '2026-11-10T13:15:00Z',
    ].map(epoch));
  });

  it.each(['', '@daily', '* * * *', '* * * * * *', '60 * * * *', '*/0 * * * *', '0 0 30 2 *', 'H * * * *'])
    ('rejects invalid or unstable cron expression %j before activation', (expression) => {
      expect(() => nextScheduleRun(expression, 'UTC', epoch('2026-01-01T00:00:00Z'))).toThrow(ApiError);
    });

  it.each(['Not/A_Zone', '', 'UTC+3'])('rejects unsupported timezone %j', (timeZone) => {
    expect(() => previewScheduleRuns('0 9 * * *', timeZone)).toThrow(ApiError);
  });

  it.each([NaN, Infinity, -1, 8_640_000_000_000_001])('rejects invalid calendar origin %j', (after) => {
    expect(() => nextScheduleRun('* * * * *', 'UTC', after)).toThrow(ApiError);
  });
});
