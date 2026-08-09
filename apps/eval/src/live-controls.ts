import path from 'node:path';

/**
 * Explicit operator controls for commands that can spend provider money.
 *
 * Evaluation commands are intentionally inert unless an operator sets all of
 * these values. The dollar amount is a declared approval ceiling recorded in
 * the run artifact; the request cap is the enforceable technical ceiling.
 */
export interface LiveEvaluationControls {
  declaredBudgetUsd: number;
  maxRequests: number;
  resultFile: string;
}

export function requireLiveCaseLimit(
  requestedCases: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!Number.isSafeInteger(requestedCases) || requestedCases < 1) {
    throw new Error('evaluation must select at least one whole case');
  }
  const maxCases = Number(env.ORVEX_EVAL_MAX_CASES);
  if (!Number.isSafeInteger(maxCases) || maxCases < 1) {
    throw new Error('ORVEX_EVAL_MAX_CASES must be a positive integer case ceiling');
  }
  if (requestedCases > maxCases) {
    throw new Error(
      `evaluation selected ${requestedCases} cases but ORVEX_EVAL_MAX_CASES permits ${maxCases}`,
    );
  }
  return maxCases;
}

export function requireLiveEvaluationControls(
  env: NodeJS.ProcessEnv = process.env,
): LiveEvaluationControls {
  if (env.ORVEX_EVAL_LIVE !== '1') {
    throw new Error(
      'live evaluation is disabled; set ORVEX_EVAL_LIVE=1 after approving a bounded run',
    );
  }

  const declaredBudgetUsd = Number(env.ORVEX_EVAL_BUDGET_USD);
  if (!Number.isFinite(declaredBudgetUsd) || declaredBudgetUsd <= 0) {
    throw new Error('ORVEX_EVAL_BUDGET_USD must be a positive declared spend ceiling');
  }

  const maxRequests = Number(env.ORVEX_EVAL_MAX_REQUESTS);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error('ORVEX_EVAL_MAX_REQUESTS must be a positive integer request ceiling');
  }

  const resultFile = env.ORVEX_EVAL_RESULT_FILE?.trim();
  if (!resultFile || !path.isAbsolute(resultFile)) {
    throw new Error(
      'ORVEX_EVAL_RESULT_FILE must be an absolute path so each live run preserves its provenance record',
    );
  }

  return { declaredBudgetUsd, maxRequests, resultFile };
}

/** Counts provider requests before they start. It cannot estimate vendor token
 * pricing, so the declared dollar ceiling remains an operator approval while
 * this cap supplies the hard, deterministic bound. */
export class EvaluationRequestBudget {
  private used = 0;
  private readonly reservedOperations: string[] = [];

  constructor(readonly controls: LiveEvaluationControls) {}

  reserve(operation: string): void {
    if (this.used >= this.controls.maxRequests) {
      throw new Error(
        `evaluation request ceiling reached (${this.controls.maxRequests}); refusing ${operation}`,
      );
    }
    this.used++;
    this.reservedOperations.push(operation);
  }

  get usedRequests(): number {
    return this.used;
  }

  /** Non-secret request lineage written to the run artifact. */
  get operations(): readonly string[] {
    return this.reservedOperations;
  }
}
