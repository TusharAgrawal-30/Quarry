// Core domain vocabulary. Quarry keeps Bugzilla's two-axis model:
// a lifecycle *status* describes where an issue is in its journey,
// while a *resolution* describes WHY it left the active pipeline.
// Collapsing these into one enum (the common modern shortcut) loses
// the ability to ask "closed, but was it actually fixed?".

export const STATUSES = [
  'unconfirmed',
  'confirmed',
  'in_progress',
  'in_review',
  'resolved',
  'verified',
  'closed',
] as const;
export type Status = (typeof STATUSES)[number];

export const RESOLUTIONS = ['fixed', 'wontfix', 'duplicate', 'invalid', 'worksforme'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

// Severity = objective impact of the defect. Priority = the team's chosen
// ordering of work. A crash in a dead feature is severity:critical,
// priority:low — the model must be able to express that.
export const SEVERITIES = ['blocker', 'critical', 'major', 'normal', 'minor', 'trivial'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const RELATION_KINDS = ['blocks', 'duplicate_of', 'regression_of'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export interface Actor {
  id: number;
  name: string;
  handle: string;
  role: string;
  hue: number;
  active: number; // 1 = current team member, 0 = departed
}

export interface Product {
  id: number;
  key: string;
  name: string;
  description: string;
}

export interface Component {
  id: number;
  product_id: number;
  name: string;
  description: string;
  lead_id: number | null;
}

export interface Issue {
  id: number;
  key: string;
  product_id: number;
  component_id: number;
  seq: number;
  title: string;
  body: string;
  status: Status;
  resolution: Resolution | null;
  severity: Severity;
  priority: Priority;
  reporter_id: number;
  assignee_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface IssueEvent {
  id: number;
  issue_id: number;
  actor_id: number;
  kind: string;
  field: string | null;
  from_value: string | null;
  to_value: string | null;
  detail: string | null;
  created_at: string;
}

export interface Comment {
  id: number;
  issue_id: number;
  author_id: number;
  body: string;
  created_at: string;
}
