export type GitHubUser = {
  login: string;
  avatar_url: string;
  name: string | null;
};

export type GitHubRepo = {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  language: string | null;
  clone_url: string;
  updated_at: string;
};

export type StageRecord = {
  stage: string;
  label: string;
  detail?: string; // e.g. "247 / 312 files"
};

export type PipelineRun = {
  runId: string;
  repoFullName: string;
  repoName: string;
  status:
    | 'queued'
    | 'ingestion'
    | 'file_summary'
    | 'repo_full_summary'
    | 'embedding'
    | 'repo_manager'
    | 'architecture'
    | 'completed'
    | 'failed';
  stageProgress: { items_total: number; items_completed: number; items_failed: number } | null;
  // ingestion-stage counters (top-level response fields, not stage_progress)
  filesSeen?: number;
  filesIngested?: number;
  stageHistory: StageRecord[];
  // sub-run IDs and statuses from poll response — used for smart retry
  fileSummaryRunId?: string;
  fileSummaryRunStatus?: string;
  repoFullSummaryRunStatus?: string;
  embeddingRunStatus?: string;
  repoManagerRunStatus?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
};

export type AvailableContext = {
  repoFullName: string;
  repoName: string;
  completedAt: string;
  runId: string;
};

export type ActiveContext = {
  repoFullName: string;
  repoName: string;
  runId: string;
  activatedAt: string;
};
