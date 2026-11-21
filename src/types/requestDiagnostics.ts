export type RequestPhase =
  | "sending"
  | "coolingDown"
  | "recoveryQueued"
  | "retrying"
  | "failingOver"
  | "streaming"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timedOut";

export type RequestReason =
  | "retryAfter"
  | "rateLimitBackoff"
  | "sharedCooldown"
  | "recoveryPermit"
  | "rateLimitRecovery"
  | "transientBackoff"
  | "requestCorrection"
  | "proxyStopped"
  | "clientDisconnected"
  | "upstreamCancelled";

export type RequestErrorClass =
  | "rateLimited"
  | "billing"
  | "authentication"
  | "permission"
  | "invalidRequest"
  | "noProvider"
  | "network"
  | "timeout"
  | "upstream"
  | "responseTooLarge"
  | "responseInterrupted"
  | "incomplete"
  | "recoveryWaitLimit"
  | "internal";

export interface RequestStep {
  phase: RequestPhase;
  attempt: number;
  offsetMs: number;
  elapsedMs: number;
  providerRef?: string;
  model?: string;
  reason?: RequestReason;
  plannedWaitMs?: number;
  waitLimitMs?: number;
  error?: { class: RequestErrorClass; httpStatus?: number };
}

export interface RequestSummary {
  id: string;
  appType: string;
  startedAtMs: number;
  elapsedMs: number;
  attempts: number;
  current: RequestStep;
}

export interface RequestDetail extends RequestSummary {
  steps: RequestStep[];
  omittedSteps: number;
}

export interface RequestDiagnosticsSnapshot {
  active: RequestSummary[];
  recent: RequestSummary[];
  untrackedActive: number;
}
