// The Skill (skills/draft-tide) names only tools and codes that exist, covers
// every tool the MCP server offers, and keeps the rules the M1 plan §11.3 sets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES, OPERATIONS, OPERATION_NAMES } from '@draft-tide/contracts';
import { describe, expect, it } from 'vitest';
import { toolName } from '../src/mcp/server.ts';
import { COMPANION } from './helpers.ts';

const SKILL_DIR = join(COMPANION, '..', '..', 'skills', 'draft-tide');
// A Windows checkout may carry CRLF; a host reads either.
const text = (file: string) => readFileSync(join(SKILL_DIR, file), 'utf8').replace(/\r\n/g, '\n');
const skill = text('SKILL.md');
const reference = text(join('references', 'reference.md'));
const TOOLS = OPERATION_NAMES.filter((op) => OPERATIONS[op].tool !== 'none').map(toolName);

function backticked(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '').filter((w) => pattern.test(w));
}

describe('the Skill', () => {
  it('has the frontmatter a host loads it by', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    expect(front).toMatch(/^name: draft-tide$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Never run Git/);
  });

  it('names only tools the MCP server offers, and covers them all', () => {
    const named = new Set(
      [...backticked(skill, /^[a-z]+(?:_[a-z]+)+$/), ...backticked(reference, /^[a-z]+(?:_[a-z]+)+$/)].filter(
        (w) => w !== 'snake_case',
      ),
    );
    for (const w of named) expect(TOOLS, w).toContain(w);
    for (const t of TOOLS) expect(named, t).toContain(t);
  });

  it('names only error codes the contracts define', () => {
    const codes = [...backticked(skill, /^[A-Z][A-Z_]+$/), ...backticked(reference, /^[A-Z][A-Z_]+$/)];
    expect(codes.length).toBeGreaterThan(20);
    for (const c of codes) expect(ERROR_CODES, c).toContain(c);
  });

  it('never tells an agent to work around the product', () => {
    for (const text of [skill, reference]) {
      expect(text).not.toMatch(/git (commit|checkout|stash|reset|clean|rebase|push) /);
      expect(text).not.toMatch(/approve/i);
      expect(text).toMatch(/token/);
    }
    expect(skill).toMatch(/Never[\s\S]*`confirmed`/);
    expect(skill).toMatch(/pre-restore version/);
    expect(skill).toMatch(/AGENT_ACCESS_DISABLED/);
  });
});
