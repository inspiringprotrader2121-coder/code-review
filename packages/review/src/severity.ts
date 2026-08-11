/**
 * Stable storage and policy values remain P-levels; this maps them to the
 * names shown to people in GitHub and the product UI.
 */
export const DISPLAY_SEVERITY: Readonly<Record<string, string>> = {
  P1: 'Critical',
  P2: 'High',
  P3: 'Medium',
  info: 'Low',
};

export function displaySeverity(severity: string): string {
  return DISPLAY_SEVERITY[severity] ?? severity;
}
