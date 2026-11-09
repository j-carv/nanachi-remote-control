import { CronExpressionParser, type CronExpression } from 'cron-parser';
import { ApiError } from './api-error.js';

function calendar(cronExpression: string, timeZone: string, after: number): CronExpression {
  if (cronExpression.length > 256 || cronExpression.trim().split(/\s+/u).length !== 5 || /\bH\b/iu.test(cronExpression)) {
    throw new ApiError(400, 'invalid_request', 'A stable five-field cron expression is required.');
  }
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(new Date(after).getTime())) {
    throw new ApiError(400, 'invalid_request', 'Invalid scheduling timestamp.');
  }
  try {
    if (timeZone.length === 0 || timeZone.length > 100) throw new Error('Invalid timezone');
    new Intl.DateTimeFormat('en', { timeZone }).format(after);
    return CronExpressionParser.parse(cronExpression, { currentDate: after, tz: timeZone, strict: false });
  } catch {
    throw new ApiError(400, 'invalid_request', 'Invalid cron expression or timezone.');
  }
}

export function nextScheduleRun(cronExpression: string, timeZone: string, after: number): number {
  try {
    return calendar(cronExpression, timeZone, after).next().getTime();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_request', 'Cron expression has no reachable next execution.');
  }
}

export function previewScheduleRuns(cronExpression: string, timeZone: string, after = Date.now()): number[] {
  try {
    return calendar(cronExpression, timeZone, after).take(5).map((date) => date.getTime());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_request', 'Cron expression has no reachable next executions.');
  }
}
