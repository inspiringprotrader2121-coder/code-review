import { DEEP_DIVE_FOCUS, HIGH_TIER_FLASH_FOCUS, THIRD_ANGLE_FOCUS } from './lenses.js';

export type ReviewStageId =
  | 'luna-agentic'
  | 'minimax-general'
  | 'flash-deep-dive'
  | 'minimax-breadth'
  | 'flash-verification';

export type ReviewModelSlot = 'luna' | 'minimax' | 'deepseek-flash';

export interface ReviewStage {
  id: ReviewStageId;
  kind: 'discovery' | 'verification';
  modelSlot: ReviewModelSlot;
  tag: string;
  modelIndex: number;
  required: boolean;
  focus?: string;
}

export interface CompiledReviewPlan {
  discovery: readonly ReviewStage[];
  verification: ReviewStage;
}

/** Every stage in execution order. Consumers that need the whole paid contract
 * should use this instead of reconstructing discovery plus verification. */
export function reviewPlanStages(plan: CompiledReviewPlan): readonly ReviewStage[] {
  return [...plan.discovery, plan.verification];
}

const FLASH_VERIFY: ReviewStage = {
  id: 'flash-verification',
  kind: 'verification',
  modelSlot: 'deepseek-flash',
  tag: 'verification',
  modelIndex: 4,
  required: true,
};

const HIGH_TIER_DISCOVERY: readonly ReviewStage[] = [
  {
    id: 'luna-agentic',
    kind: 'discovery',
    modelSlot: 'luna',
    tag: 'general',
    modelIndex: 0,
    required: true,
  },
  {
    id: 'flash-deep-dive',
    kind: 'discovery',
    modelSlot: 'deepseek-flash',
    tag: 'deep-dive',
    modelIndex: 1,
    required: true,
    focus: HIGH_TIER_FLASH_FOCUS,
  },
  {
    id: 'minimax-breadth',
    kind: 'discovery',
    modelSlot: 'minimax',
    tag: 'perf/completeness/api',
    modelIndex: 3,
    required: true,
    focus: THIRD_ANGLE_FOCUS,
  },
] as const;

const LOWER_TIER_DISCOVERY: readonly ReviewStage[] = [
  {
    id: 'minimax-general',
    kind: 'discovery',
    modelSlot: 'minimax',
    tag: 'general',
    modelIndex: 0,
    required: true,
  },
  {
    id: 'flash-deep-dive',
    kind: 'discovery',
    modelSlot: 'deepseek-flash',
    tag: 'deep-dive',
    modelIndex: 1,
    required: true,
    focus: DEEP_DIVE_FOCUS,
  },
] as const;

/** Compile the fixed public-plan model contract without reading environment state. */
export function compileReviewPlan(modelTier: string | undefined): CompiledReviewPlan | null {
  if (modelTier === 'multi-model') {
    return { discovery: HIGH_TIER_DISCOVERY, verification: FLASH_VERIFY };
  }
  if (modelTier === 'dual-model') {
    return { discovery: LOWER_TIER_DISCOVERY, verification: FLASH_VERIFY };
  }
  return null;
}
