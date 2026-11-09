import type { ScheduleModelsResponse, ScheduleRun, ScheduleTask } from '@nanachi/shared';

export interface ScheduleExecutionUpdate {
  status?: 'running' | 'awaiting_permission';
  sessionId?: string;
  output?: string;
}

export interface ScheduleExecutionResult {
  status: 'succeeded' | 'failed';
  exitCode?: number | null;
  error?: string;
}

export interface ScheduleExecutor {
  validate(workspaceId: string, task: ScheduleTask): void;
  execute(run: ScheduleRun, signal: AbortSignal, update: (change: ScheduleExecutionUpdate) => void): Promise<ScheduleExecutionResult>;
  models(workspaceId: string, agentId: string, accountId: string, signal: AbortSignal): Promise<ScheduleModelsResponse>;
  forget(run: ScheduleRun): Promise<void>;
}

