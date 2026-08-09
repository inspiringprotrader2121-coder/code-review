import type { InvestigateToolCall } from './contracts.js';
import { listDirectory, readFile } from './files.js';
import { findCallers, findTests } from './repository.js';
import { grepRepository } from './search.js';

export async function runInvestigateTool(
  root: string,
  tool: InvestigateToolCall,
  maxChars: number,
): Promise<string> {
  switch (tool.name) {
    case 'list_dir':
      return listDirectory(root, tool.path, maxChars);
    case 'read_file':
      return readFile(root, tool.path, tool.offset, tool.limit, maxChars);
    case 'grep':
      return grepRepository(
        root,
        tool.pattern,
        tool.path,
        tool.glob,
        tool.caseInsensitive,
        maxChars,
      );
    case 'find_callers':
      return findCallers(root, tool.symbol, tool.path, maxChars);
    case 'find_tests':
      return findTests(root, tool.path, maxChars);
  }
}
