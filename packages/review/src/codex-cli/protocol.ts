import fs from 'node:fs';
import type { CodexExecArgsOptions } from './contracts.js';

export function buildCodexExecArgs(options: CodexExecArgsOptions): string[] {
  const args = [
    'exec',
    '--model',
    options.model,
    '--json',
    ...(options.outerSandboxed
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'read-only']),
    '--ignore-user-config',
    '--ignore-rules',
    '-c',
    'shell_environment_policy.exclude=["CODEX_HOME","OPENAI_API_KEY","CODEX_API_KEY","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"]',
    '--skip-git-repo-check',
    '--output-last-message',
    options.lastMessageFile,
  ];
  if (!options.threadId) args.push('--cd', options.cwd);
  if (options.reasoningEffort)
    args.push('-c', `model_reasoning_effort="${options.reasoningEffort}"`);
  if (options.threadId) args.push('resume', options.threadId);
  args.push('-');
  return args;
}

export function codexAnnouncedModelFallback(output: string): boolean {
  const compact = output.replace(/\s+/g, ' ');
  return (
    /(?:model\s+)?[\w.-]+\s+(?:is\s+)?not supported.{0,160}\bfalling back to\b/i.test(compact) ||
    /\bfalling back to\s+(?:model\s+)?(?:gpt-|codex-|o[1-9](?:\b|-))/i.test(compact)
  );
}

export function extractThreadId(stdout: string): string {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };
      if (event.type === 'thread.started' && event.thread_id) return event.thread_id;
    } catch {
      /* non-protocol output */
    }
  }
  return '';
}

export type CodexUsage = { input?: number; output?: number; reasoning?: number };
export function extractUsage(stdout: string): CodexUsage | undefined {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
      };
      if (event.type === 'turn.completed' && event.usage) {
        return {
          input: event.usage.input_tokens,
          output: event.usage.output_tokens,
          reasoning: event.usage.reasoning_output_tokens,
        };
      }
    } catch {
      /* non-protocol output */
    }
  }
  return undefined;
}

export function readLastMessage(file: string): string {
  try {
    const stat = fs.statSync(file);
    const maxChars = 256_000;
    if (stat.size <= maxChars) return fs.readFileSync(file, 'utf8').trim();
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(maxChars);
      fs.readSync(fd, buffer, 0, maxChars, Math.max(0, stat.size - maxChars));
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function extractErrorMessage(stdout: string, stderr: string): string | undefined {
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: string;
        error?: { message?: string };
      };
      if (event.type === 'error' || event.type === 'turn.failed') {
        return event.message ?? event.error?.message ?? JSON.stringify(event.error);
      }
    } catch {
      /* non-protocol output */
    }
  }
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return undefined;
  return (
    /request too large[^\n]{0,200}|context[_ ]length[_ ]exceeded[^\n]{0,200}|maximum context length[^\n]{0,200}/i
      .exec(combined)?.[0]
      ?.trim() ?? combined
  );
}

export function isStaleThreadError(message: string): boolean {
  return /no rollout found for thread|thread\/resume failed|thread not found|unknown thread/i.test(
    message,
  );
}
