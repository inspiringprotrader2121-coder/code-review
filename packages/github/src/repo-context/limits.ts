import type { BuildContextOptions, ContextBudgets } from './contracts.js';

const nonNegativeInt = (value: number | undefined, fallback: number, max: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), max)
    : fallback;

export function resolveContextBudgets(opts: BuildContextOptions = {}): ContextBudgets {
  return {
    maxRelated: nonNegativeInt(opts.maxRelated, 8, 100),
    maxDependents: nonNegativeInt(opts.maxDependents, 8, 100),
    maxFileBytes: nonNegativeInt(opts.maxFileBytes, 16_000, 1_000_000),
    maxSourceFiles: nonNegativeInt(opts.maxSourceFiles, 10, 100),
    maxOthers: nonNegativeInt(opts.maxOthers, 0, 1_000),
  };
}

export function clipContextFile(content: string, maxFileBytes: number): string {
  return content.length > maxFileBytes
    ? `${content.slice(0, maxFileBytes)}\n… (truncated)`
    : content;
}

export function resolveArchiveCap(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
