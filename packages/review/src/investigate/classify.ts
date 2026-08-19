import { extractJsonLoose } from '../llm-client.js';
import { normalizeLlmResponse, parseReviewJson } from '../llm.js';
import { LlmReviewResponseSchema, type LlmReviewResponse } from '../types.js';
import { StepSchema, type InvestigateStep } from './contracts.js';

export type InvestigateResponseShape =
  | 'final'
  | 'step'
  | 'tool_call'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'empty';

export type ClassifiedInvestigateResponse =
  | { type: 'final'; value: LlmReviewResponse; shape: 'final' }
  | { type: 'step'; value: Extract<InvestigateStep, { action: 'tool' }>; shape: 'tool_call' }
  | { type: 'invalid'; shape: 'invalid_json' | 'schema_mismatch' | 'empty' };

function stripStructuredOutputNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStructuredOutputNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, stripStructuredOutputNulls(entry)]),
  );
}

function unwrapStepEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  return root.step && typeof root.step === 'object' ? root.step : value;
}

function asFinalReview(value: unknown): LlmReviewResponse | null {
  const candidate = unwrapStepEnvelope(value);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const root = candidate as Record<string, unknown>;
  const action = typeof root.action === 'string' ? root.action.trim().toLowerCase() : '';
  if (action === 'tool') return null;
  if (action === 'done' || action === 'final' || Array.isArray(root.findings)) {
    try {
      const parsed = LlmReviewResponseSchema.safeParse(
        normalizeLlmResponse({ findings: root.findings ?? [], summary: root.summary }),
      );
      if (parsed.success) return parsed.data;
    } catch {
      // Incomplete finding objects are a schema miss, not a completed pass.
    }
    try {
      return parseReviewJson(JSON.stringify(candidate));
    } catch {
      return null;
    }
  }
  return null;
}

function asToolStep(value: unknown): Extract<InvestigateStep, { action: 'tool' }> | null {
  const candidate = unwrapStepEnvelope(value);
  const parsed = StepSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.action !== 'tool') return null;
  return parsed.data;
}

/** Classify an investigate model reply. Final results win over tool steps. */
export function classifyInvestigateResponse(text: string): ClassifiedInvestigateResponse {
  const trimmed = text.trim();
  if (!trimmed) return { type: 'invalid', shape: 'empty' };
  let parsed: unknown;
  try {
    parsed = stripStructuredOutputNulls(extractJsonLoose(trimmed));
  } catch {
    return { type: 'invalid', shape: 'invalid_json' };
  }
  const final = asFinalReview(parsed);
  if (final) return { type: 'final', value: final, shape: 'final' };
  const step = asToolStep(parsed);
  if (step) return { type: 'step', value: step, shape: 'tool_call' };
  return { type: 'invalid', shape: 'schema_mismatch' };
}
