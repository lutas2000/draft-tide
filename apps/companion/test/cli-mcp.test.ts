import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EXIT_CODES } from '@draft-tide/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI_SOURCE, cleanupDataDirs, connectTo, tempDataDir } from './helpers.ts';

afterAll(cleanupDataDirs);

function cli(dataDir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_SOURCE, '--data-dir', dataDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DRAFT_TIDE_ENGINE_IDLE_MS: '2000' },
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('CLI', () => {
  it('prints exactly one envelope line with --json', () => {
    const dataDir = tempDataDir();
    const r = cli(dataDir, '--json', 'engine', 'info');
    expect(r.status).toBe(EXIT_CODES.ok);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      schemaVersion: 1,
      ok: true,
      data: { channel: 'cli' },
      error: null,
    });
  });

  it('reports AGENT_ACCESS_DISABLED with exit code 1 and a hint in human mode', () => {
    const dataDir = tempDataDir();
    const json = cli(dataDir, '--json', 'project', 'list');
    expect(json.status).toBe(EXIT_CODES.failed);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: { code: 'AGENT_ACCESS_DISABLED', retryable: false },
    });
    const human = cli(dataDir, 'project', 'list');
    expect(human.stdout).toBe('');
    expect(human.stderr).toMatch(/AGENT_ACCESS_DISABLED[\s\S]*Settings/);
  });

  it('lists projects once the desktop turns agent access on', async () => {
    const dataDir = tempDataDir();
    const desktop = await connectTo(dataDir, 'desktop');
    await desktop.call('agentAccess.set', { enabled: true });
    desktop.close();
    const r = cli(dataDir, '--json', 'project', 'list');
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, data: [] });
    expect(cli(dataDir, 'project', 'list').stdout).toBe('No connected design folders.\n');
  });

  it('answers usage errors with INVALID_ARGUMENT and exit code 2', () => {
    const r = cli(tempDataDir(), '--json', 'snapshot', '--force');
    expect(r.status).toBe(EXIT_CODES.usage);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('MCP server', () => {
  async function mcpClient(dataDir: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_SOURCE, '--data-dir', dataDir, 'mcp', 'serve'],
      env: { ...(process.env as Record<string, string>), DRAFT_TIDE_ENGINE_IDLE_MS: '2000' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'draft-tide-test', version: '0' });
    await client.connect(transport);
    return client;
  }

  const envelopeOf = (result: unknown) => {
    const content = (result as { content: { type: string; text: string }[] }).content;
    return JSON.parse(content[0]?.text ?? '') as { ok: boolean; error: { code: string } | null; data: unknown };
  };

  it('offers only tool-channel operations, with honest annotations', async () => {
    const client = await mcpClient(tempDataDir());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'engine_info',
      'history_list',
      'operation_cancel',
      'operation_status',
      'project_connect_request',
      'project_list',
      'project_restore_settings',
      'project_status',
      'recovery_apply',
      'recovery_inspect',
      'recovery_plan',
      'restore_apply',
      'restore_plan',
      'snapshot_create',
      'snapshot_diff',
      'snapshot_diff_file',
    ]);
    // Connecting a folder is the GUI's alone (the tool can only ask). Restore
    // and recovery apply overwrite files and say so; plans only read.
    const destructive = ['restore_apply', 'recovery_apply'];
    const writes = [
      'snapshot_create',
      'operation_cancel',
      'project_connect_request',
      'project_restore_settings',
      ...destructive,
    ];
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({
        readOnlyHint: !writes.includes(t.name),
        destructiveHint: destructive.includes(t.name),
      });
    }
    expect(client.getInstructions()).toMatch(/AGENT_ACCESS_DISABLED/);
    await client.close();
  });

  it('goes through the same Engine and access rules as the CLI', async () => {
    const dataDir = tempDataDir();
    const client = await mcpClient(dataDir);
    const info = await client.callTool({ name: 'engine_info', arguments: {} });
    expect(info.isError).toBe(false);
    expect(envelopeOf(info)).toMatchObject({ ok: true, data: { channel: 'mcp', agentAccess: { enabled: false } } });

    const denied = await client.callTool({ name: 'project_list', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(envelopeOf(denied).error?.code).toBe('AGENT_ACCESS_DISABLED');

    const desktop = await connectTo(dataDir, 'desktop');
    await desktop.call('agentAccess.set', { enabled: true });
    const allowed = await client.callTool({ name: 'project_list', arguments: {} });
    expect(envelopeOf(allowed)).toMatchObject({ ok: true, data: [] });
    desktop.close();
    await client.close();
  });
});
