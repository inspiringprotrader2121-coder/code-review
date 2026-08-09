export function isProtectedSourceTier(sourceTier: string | undefined): boolean {
  return (
    sourceTier === 'openai' ||
    sourceTier === 'deepseek' ||
    sourceTier === 'deepseek-flash' ||
    sourceTier === 'deterministic'
  );
}

export function isWeakVerifierTier(verifierTier: string | undefined): boolean {
  return verifierTier === undefined || verifierTier === 'standard';
}

export function shouldRescueHedgedRejection(
  sourceTier: string | undefined,
  reason: string,
  verifierTier?: string,
): boolean {
  return (
    isProtectedSourceTier(sourceTier) &&
    isHedgedRejection(reason) &&
    isWeakVerifierTier(verifierTier)
  );
}

const STRONG_HEDGE =
  /\b(?:cannot|can'?t|could not|couldn'?t|unable to|not able to)\s+(?:independently\s+)?(?:verify|confirm|re-derive|reproduce|determine|tell|establish|find|check)|\b(?:unclear|uncertain|unverifiable|inconclusive|ambiguous)\b|\binsufficient\b|\bnot enough\b|\black(?:s|ing)?\s+(?:of\s+)?(?:context|evidence|information|detail)|\b(?:may|might|could)\s+(?:be|not be)\b|\bpossibly\b|\bprobably\b|\bperhaps\b|\bnot sure\b|\blikely\s+(?:intentional|fine|safe)\b|\bseems?\s+(?:fine|correct|okay|ok|safe|intentional)\b|\bappears?\s+(?:fine|correct|safe|intentional)\b|\bwithout\s+(?:the\s+)?(?:caller|context|more)\b|\b(?:validated|handled|checked|guarded|mitigated|covered|addressed)\s+elsewhere\b|\bcould not find evidence\b|\bpresumably\b/i;
const EMPTY_REJECTION = /^(?:rejected(?: by verification)?|no|n\/a|none|invalid|false)\.?$/i;

export function isHedgedRejection(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed === '' || EMPTY_REJECTION.test(trimmed) || STRONG_HEDGE.test(trimmed);
}
