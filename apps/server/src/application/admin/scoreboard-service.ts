import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInstallationOctokit, type GitHubAppConfig } from '@orvex-review/github';
import type { RepositoryWriteRepository } from '@orvex-review/store';
import { buildScoreboard, type Scoreboard } from '../../scoreboard.js';

export type ScoreboardStore = Pick<RepositoryWriteRepository, 'listScanTargets'>;

export type ScoreboardSnapshot = Scoreboard & {
  repos?: Array<{
    repo: string;
    prsAnalyzed: number;
    bots: Scoreboard['bots'];
    clustersTotal: number;
  }>;
};

export type ScoreboardLoadResult =
  | { kind: 'ok'; scoreboard: ScoreboardSnapshot }
  | { kind: 'missing'; scoreboard: ScoreboardSnapshot & { empty: true } };

export type ScoreboardReadResult = { kind: 'invalid_name' | 'not_found' | 'unreadable' };

export class ScoreboardService {
  constructor(
    private readonly store: ScoreboardStore,
    private readonly databasePath: string,
    private readonly rulesPaths: readonly string[] = [
      path.resolve('rules/orvex-rules.md'),
      path.resolve('../../rules/orvex-rules.md'),
    ],
  ) {}

  read(): ScoreboardLoadResult {
    try {
      return {
        kind: 'ok',
        scoreboard: JSON.parse(readFileSync(this.scoreboardPath(), 'utf8')) as Scoreboard,
      };
    } catch {
      return { kind: 'missing', scoreboard: { ...emptyScoreboard(), empty: true } };
    }
  }

  async rebuild(
    github: GitHubAppConfig,
    maxPrs: number,
  ): Promise<
    { kind: 'ok'; scoreboard: ScoreboardSnapshot } | { kind: 'no_targets' | 'all_failed' }
  > {
    const targets = this.store.listScanTargets();
    if (targets.length === 0) return { kind: 'no_targets' };
    const rulesHash = this.rulesHash();
    const boards: Scoreboard[] = [];
    for (const target of targets) {
      try {
        const board = await buildScoreboard(
          createInstallationOctokit(github, target.installationId),
          target.owner,
          target.name,
          maxPrs,
        );
        board.rulesHash = rulesHash;
        boards.push(board);
      } catch (error) {
        console.warn(
          `[superadmin] scoreboard failed for ${target.fullName}:`,
          (error as Error).message,
        );
      }
    }
    if (boards.length === 0) return { kind: 'all_failed' };
    const primary = boards[0]!;
    const scoreboard: ScoreboardSnapshot =
      boards.length === 1
        ? primary
        : {
            ...primary,
            repos: boards.map((board) => ({
              repo: board.repo,
              prsAnalyzed: board.prsAnalyzed,
              bots: board.bots,
              clustersTotal: board.clusters.total,
            })),
          };
    this.write(scoreboard, rulesHash);
    return { kind: 'ok', scoreboard };
  }

  history(): Array<{ file: string; at: string; rulesHash: string | null }> {
    const directory = this.historyPath();
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .map((file) => {
        const base = file.replace(/\.json$/i, '');
        const index = base.lastIndexOf('_');
        return {
          file,
          at: index >= 0 ? base.slice(0, index) : base,
          rulesHash: index >= 0 ? base.slice(index + 1) : null,
        };
      });
  }

  readHistory(file: string): ScoreboardLoadResult | ScoreboardReadResult {
    if (!file || file.includes('/') || file.includes('..') || !file.endsWith('.json'))
      return { kind: 'invalid_name' };
    const fullPath = path.join(this.historyPath(), file);
    if (!existsSync(fullPath)) return { kind: 'not_found' };
    try {
      return { kind: 'ok', scoreboard: JSON.parse(readFileSync(fullPath, 'utf8')) as Scoreboard };
    } catch {
      return { kind: 'unreadable' };
    }
  }

  private scoreboardPath(): string {
    return path.join(path.dirname(this.databasePath), 'scoreboard.json');
  }
  private historyPath(): string {
    return path.join(path.dirname(this.scoreboardPath()), 'scoreboard-history');
  }
  private rulesHash(): string {
    for (const candidate of this.rulesPaths) {
      try {
        return createHash('sha256').update(readFileSync(candidate)).digest('hex').slice(0, 12);
      } catch {
        /* cwd differs under PM2 and tests */
      }
    }
    return 'unknown';
  }
  private write(scoreboard: ScoreboardSnapshot, rulesHash: string): void {
    mkdirSync(path.dirname(this.scoreboardPath()), { recursive: true });
    writeFileSync(this.scoreboardPath(), JSON.stringify(scoreboard, null, 2));
    mkdirSync(this.historyPath(), { recursive: true });
    writeFileSync(
      path.join(
        this.historyPath(),
        `${new Date().toISOString().replace(/[:.]/g, '-')}_${rulesHash}.json`,
      ),
      JSON.stringify(scoreboard, null, 2),
    );
  }
}

function emptyScoreboard(): Scoreboard {
  return {
    repo: '(none)',
    generatedAt: '',
    prsAnalyzed: 0,
    bots: {},
    clusters: { total: 0, orvexMissed: [], orvexUnique: [] },
    perPr: [],
  };
}
