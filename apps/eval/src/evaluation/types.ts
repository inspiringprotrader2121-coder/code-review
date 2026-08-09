import type { ReviewFinding } from '@orvex-review/review';

export interface CaseResult {
  name: string;
  findings: ReviewFinding[];
  recallHits: number;
  recallTotal: number;
  falsePositives: number;
  missing: string[];
  falsePos: string[];
}

/** LLM target for one controlled evaluation model-lineup pass. */
export interface PassTarget {
  apiKey: string;
  baseUrl?: string;
  model: string;
  api?: 'chat' | 'responses' | 'anthropic';
  reasoningEffort?: string;
}

export interface EvaluationPass {
  tag: string;
  target: PassTarget;
  focus?: string;
  tier: ReviewFinding['sourceTier'];
  bestEffort?: boolean;
}

export interface PrReviewResult {
  findings: ReviewFinding[];
  /** Candidates production keeps on the manual-review surface, excluded from scored normal findings. */
  manualReviewCount: number;
  manualReviewFindings: ReviewFinding[];
  /** Passes that completed and produced a real (possibly empty) review. */
  okPasses: number;
  totalPasses: number;
  /** Minimum required samples production needs before it will post a review. */
  requiredPasses: number;
  /** Required samples that actually completed. */
  okRequired: number;
}

export interface EvaluationLogger {
  log(message: string): void;
}

export const consoleLogger: EvaluationLogger = {
  log(message: string): void {
    console.log(message);
  },
};
