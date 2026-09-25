import type { BrainPage, LinkType } from "../../brain/types";
import { DEFAULT_DECISION_POLICY } from "./decision-policy";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Question =
  | {
      type: "boolean";
      instructions: string;
      criteria?: { true: string; false: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type Answer =
  | { type: "boolean"; probability: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number | null;
    };
export type EvaluationRequest = {
  state: Json;
  questions: Record<string, Question>;
};
export type Evaluation = {
  answers: Record<string, Answer>;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  providerMetadata?: Json;
};
export type Evaluate = (request: EvaluationRequest) => Promise<Evaluation>;
export type Judgment = EvaluationRequest & Evaluation;

export type EvidenceUnit = {
  id: string;
  pageId: string;
  start: number;
  end: number;
  text: string;
  headings: string[];
  context: string;
};
export type Snapshot = {
  id: string;
  createdAt: string;
  pages: BrainPage[];
  units: EvidenceUnit[];
};
export type AnalysisTask = {
  id: string;
  kind: "document" | "pair";
  pageIds: string[];
  unitIds: string[];
};
export type OperationKind =
  | "deduplicate"
  | "centralize"
  | "add_link"
  | "reconcile"
  | "remove_maintenance_residue";
export type Finding = {
  id: string;
  kind: OperationKind;
  status: "supported" | "uncertain";
  pageIds: string[];
  unitIds: string[];
  evidenceUnitIds: string[];
  canonicalPageId?: string;
  retainedUnitId?: string;
  link?: { sourceId: string; targetId: string; type: LinkType };
  resolution?: "a" | "b" | "temporal" | "scope";
  goal: string;
};
export type AnalysisResult = {
  taskId: string;
  findings: Finding[];
  judgments: Judgment[];
  status: "complete" | "incomplete";
  errors?: { questionIds: string[]; reason: string }[];
};
export type VersionRef = { pageId: string; version: number };
export type OperationPlan = {
  id: string;
  kind: OperationKind;
  findingIds: string[];
  targetPageIds: string[];
  targetUnitIds: string[];
  evidenceUnitIds: string[];
  readSet: VersionRef[];
  canonicalPageId?: string;
  retainedUnitId?: string;
  link?: Finding["link"];
  resolution?: Finding["resolution"];
  correctionUnitIds?: string[];
  goal: string;
};
export type TextPatch = {
  pageId: string;
  unitId: string;
  before: string;
  after: string;
};
export type SummaryPatch = { pageId: string; before: string; after: string };
export type LinkAddition = {
  sourceId: string;
  targetId: string;
  type: LinkType;
  label: string;
};
export type Draft = {
  patches: TextPatch[];
  links: LinkAddition[];
  noChange: boolean;
  summaryPatches?: SummaryPatch[];
};
export type MaterializedChange = { before: BrainPage; after: BrainPage };
export type ChangeSet = {
  id: string;
  plan: OperationPlan;
  draft: Draft;
  changes: MaterializedChange[];
};
export type Verification = {
  status: "accepted" | "rejected" | "uncertain";
  defects: string[];
  judgments: Judgment[];
  incomplete?: boolean;
};
export type Editor = (
  snapshot: Snapshot,
  plan: OperationPlan,
  feedback?: string[],
) => Promise<Draft>;
export type ApplyResult =
  | { status: "applied" | "replayed"; pages: BrainPage[] }
  | { status: "conflict"; pageIds: string[] };
export type DecisionRecord = {
  operationId: string;
  status:
    | "no_change"
    | "rejected"
    | "uncertain"
    | "applied"
    | "conflict"
    | "error";
  reason?: string;
  changeSet?: ChangeSet;
  verification?: Verification;
  evidenceVersions?: VersionRef[];
};

export const POLICY = {
  version: DEFAULT_DECISION_POLICY.id,
  maxUnitCharacters: 2400,
  windowCharacters: 12_000,
  evaluationCharacters: 100_000,
  questionsPerRequest: 48,
  concurrency: 6,
  contextExpansions: 2,
  draftRepairs: 1,
  maxWaves: 4,
  tasksPerRun: 2000,
} as const;
