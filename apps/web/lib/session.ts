/**
 * Folds the RunEvent stream into what the run stream and undo console render.
 * Pure and framework-free so it is unit-tested and shared by the mock and the real API: both emit
 * the same events, so the panel cannot tell them apart.
 */
import type { ActionRecord, EffectRecord, RunEvent, RunMode } from '@backtrack/core/contracts';

type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

export interface RunView {
  runId: string;
  agentId: string;
  mode: RunMode;
  goal: string;
  model: string | null;
  status: 'running' | 'paused' | 'done' | 'failed';
  startedAt: number;
}

export interface ApprovalView {
  runId: string;
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  wouldLock: number;
  lockedTools: string[];
  state: 'pending' | 'approved' | 'denied';
}

export interface StepView {
  stepId: string;
  runId: string;
  index: number;
  thought: string;
  ts: number;
  action: ActionRecord | null;
  effects: EffectRecord[];
  dependsOn: string[];
  trace: EventOf<'action.recorded'>['trace'] | null;
  approval: ApprovalView | null;
  blocked: { policyId: string; rule: string } | null;
}

export interface UndoExecutionView {
  planId: string;
  /** Latest status per plan step order. */
  steps: Record<number, EventOf<'undo.step'>>;
  status: 'running' | EventOf<'undo.finished'>['status'];
}

export interface SessionState {
  runs: RunView[];
  steps: StepView[];
  undo: UndoExecutionView | null;
  errors: string[];
}

export const initialSession: SessionState = { runs: [], steps: [], undo: null, errors: [] };

export type SessionAction = RunEvent | { type: 'session.reset' };

/** Replaces the last step of a run (where approvals and blocks attach) or a step by id. */
function updateStep(
  steps: StepView[],
  match: (step: StepView) => boolean,
  update: (step: StepView) => StepView,
): StepView[] {
  const index = steps.findLastIndex(match);
  if (index === -1) return steps;
  const next = steps.slice();
  next[index] = update(steps[index] as StepView);
  return next;
}

const setRunStatus = (runs: RunView[], runId: string, status: RunView['status']) =>
  runs.map((run) => (run.runId === runId ? { ...run, status } : run));

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'session.reset':
      return initialSession;
    case 'run.started':
      return {
        ...state,
        runs: [
          ...state.runs,
          {
            runId: action.runId,
            agentId: action.agentId,
            mode: action.mode,
            goal: action.goal,
            model: action.model,
            status: 'running',
            startedAt: action.ts,
          },
        ],
      };
    case 'step':
      return {
        ...state,
        steps: [
          ...state.steps,
          {
            stepId: action.stepId,
            runId: action.runId,
            index: action.index,
            thought: action.thought,
            ts: action.ts,
            action: null,
            effects: [],
            dependsOn: [],
            trace: null,
            approval: null,
            blocked: null,
          },
        ],
      };
    case 'action.recorded':
      return {
        ...state,
        steps: updateStep(
          state.steps,
          (s) => s.stepId === action.action.stepId,
          (s) => ({
            ...s,
            action: action.action,
            effects: action.effects,
            dependsOn: action.dependsOn,
            trace: action.trace,
          }),
        ),
      };
    case 'approval.requested': {
      const { type: _type, ...request } = action;
      return {
        ...state,
        runs: setRunStatus(state.runs, action.runId, 'paused'),
        steps: updateStep(
          state.steps,
          (s) => s.runId === action.runId,
          (s) => ({ ...s, approval: { ...request, state: 'pending' } }),
        ),
      };
    }
    case 'approval.resolved':
      return {
        ...state,
        runs: setRunStatus(state.runs, action.runId, 'running'),
        steps: updateStep(
          state.steps,
          (s) => s.approval?.actionId === action.actionId,
          (s) =>
            s.approval
              ? {
                  ...s,
                  approval: { ...s.approval, state: action.approved ? 'approved' : 'denied' },
                }
              : s,
        ),
      };
    case 'action.blocked':
      return {
        ...state,
        steps: updateStep(
          state.steps,
          (s) => s.runId === action.runId,
          (s) => ({ ...s, blocked: { policyId: action.policyId, rule: action.rule } }),
        ),
      };
    case 'run.finished':
      return {
        ...state,
        runs: setRunStatus(state.runs, action.runId, action.status),
      };
    case 'undo.step': {
      const current = state.undo?.planId === action.planId ? state.undo : null;
      return {
        ...state,
        undo: {
          planId: action.planId,
          steps: { ...current?.steps, [action.order]: action },
          status: 'running',
        },
      };
    }
    case 'undo.finished':
      return {
        ...state,
        undo: state.undo ? { ...state.undo, status: action.status } : null,
      };
    case 'error':
      return {
        ...state,
        errors: [...state.errors, action.message],
        runs: action.runId ? setRunStatus(state.runs, action.runId, 'failed') : state.runs,
      };
  }
}

/** The approval the run is waiting on, if any. */
export const pendingApproval = (state: SessionState): ApprovalView | null =>
  state.steps.findLast((s) => s.approval?.state === 'pending')?.approval ?? null;

export const latestRun = (state: SessionState): RunView | null => state.runs.at(-1) ?? null;
