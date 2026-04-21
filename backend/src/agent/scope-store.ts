let activeRunId: string | null = null;

export function setActiveRunId(runId: string | null) {
  activeRunId = runId;
  console.log(`[Scope] run_id → ${runId ?? '(none)'}`);
}

export function getActiveRunId(): string | null {
  return activeRunId;
}
