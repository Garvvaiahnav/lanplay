// Helper to build StepRecords uniformly: times the work, captures thrown errors as 'fail'.
import type { StepRecord, StepStatus } from '../../contracts.js';

export interface StepOutcome {
  status: StepStatus;
  message: string;
  data?: Record<string, unknown>;
}

export interface StepScratch {
  commands: StepRecord['commands'];
  data: Record<string, unknown>;
}

export async function timedStep(
  stepId: string,
  title: string,
  work: (s: StepScratch) => Promise<StepOutcome>,
  now: () => number = Date.now,
): Promise<StepRecord> {
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const scratch: StepScratch = { commands: [], data: {} };
  let out: StepOutcome;
  try {
    out = await work(scratch);
  } catch (err) {
    out = { status: 'fail', message: `Unexpected error: ${(err as Error)?.message ?? String(err)}` };
    scratch.data.errorStack = String((err as Error)?.stack ?? '').split('\n').slice(0, 6).join('\n');
  }
  const data = { ...scratch.data, ...(out.data ?? {}) };
  const rec: StepRecord = {
    stepId,
    title,
    status: out.status,
    startedAt,
    durationMs: now() - t0,
    message: out.message,
    commands: scratch.commands,
  };
  if (Object.keys(data).length > 0) rec.data = data;
  return rec;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
