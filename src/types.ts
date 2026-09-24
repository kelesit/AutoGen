export interface User {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  credits: number;
  reserved: number;
  created_at: number;
}
export interface InputSlot {
  key: string;
  kind: "person" | "scene";
  label: string;
  required: true;
  referenceRole?: string;
}
export interface OutputOptions {
  default: { duration: number; resolution: string };
  allowedDurations: number[];
  allowedResolutions: string[];
  allowUserPrompt: boolean;
}
export interface Template {
  kind: "motion";
  id: string;
  title: string;
  subtitle: string;
  category: string;
  creator: string;
  image: string;
  tags: string[];
  uses: number;
  color: string;
  favorite: boolean;
  version: number;
  versionId: string;
  status: "private" | "public" | "deleted";
  inputSlots: InputSlot[];
  outputOptions: OutputOptions;
  preview_url: string | null;
  previewAssetId: string | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}
export interface AdminTemplate extends Template {
  motionVideoIds: string[];
  promptRecipe: string;
  jobCount: number;
}
export interface TemplateSnapshot extends AdminTemplate {
  model: string;
  preset: string;
}
export interface Job {
  id: string;
  template_id: string;
  template: TemplateSnapshot;
  status:
    | "queued"
    | "submitting"
    | "submission_unknown"
    | "running"
    | "persisting"
    | "needs_review"
    | "completed"
    | "failed"
    | "cancelled";
  billing_state: "held" | "settled" | "released";
  provider_id: string | null;
  scenario: string;
  quote: { version: string; credits: number; settlement: string } | null;
  template_snapshot: string | null;
  retries: number;
  review_phase: string | null;
  progress: number;
  cost: number;
  resolution: string;
  duration: number;
  prompt: string;
  created_at: number;
  accepted_at: number | null;
  output_url: string | null;
  creation_id?: string | null;
  creation_deleted?: boolean;
  input_assets?: Record<string, string> | null;
  error: string | null;
  user_name?: string;
  email?: string;
}
export interface Ledger {
  id: string;
  job_id: string | null;
  kind: string;
  amount: number;
  reserved_delta: number;
  description: string;
  created_at: number;
  user_name?: string;
}
export interface AdminData {
  runtime: {
    heartbeat: number;
    worker_online: boolean;
    paused_until: number;
    max_concurrency: number;
    needs_review: number;
  };
  stats: { users: number; jobs: number; active: number; completed: number; credits: number };
  jobs: Job[];
  users: User[];
  ledger: Ledger[];
}
export type Page = "explore" | "collection" | "credits" | "admin";
export interface JobDetail {
  job: Job;
  events: { id: number; kind: string; message: string; created_at: number }[];
  attempts: { id: number; phase: string; outcome: string; detail: string; created_at: number }[];
  media: { bytes: number; sha256: string } | null;
  supplier_cost: { cost_units: number; unit: string } | null;
  work: { due_at: number; lease_until: number } | null;
}
