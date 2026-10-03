// The de-identification of the diagnostics report's free text (the Engine
// log): every value the Engine knows to be private is replaced by a label,
// ids keep their correlation within one report, and a label is never redacted
// again.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLabeler, createRedactor } from '../src/index.ts';

const PROJECT = '0f0e1d2c-3b4a-4596-8778-695a4b3c2d1e';
const OTHER = '11111111-2222-4333-8444-555555555555';
const OID = 'a'.repeat(40);

function redactor(extra: { paths?: string[]; words?: string[] } = {}) {
  const labeler = createLabeler();
  labeler.project(PROJECT);
  const redact = createRedactor({
    paths: [
      { value: '/Users/ann/Designs/Client X', label: '<project-1 folder>' },
      { value: '/Users/ann/Library/Application Support/Draft Tide', label: '<private path>' },
      { value: '/Users/ann', label: '<private path>' },
      ...(extra.paths ?? []).map((value) => ({ value, label: '<private path>' })),
    ],
    words: [
      { value: 'Client X', label: '<project-1 name>' },
      { value: 'ann-gh', label: '<github-account>' },
      { value: 'ab', label: '<private name>' },
      ...(extra.words ?? []).map((value) => ({ value, label: '<private name>' })),
    ],
    labeler,
  });
  return { labeler, redact };
}

describe('the diagnostics redactor', () => {
  it('replaces folders, names, accounts, ids, tokens and addresses', () => {
    const { redact } = redactor();
    const log = [
      `2026-10-03T00:00:00.000Z [engine 42 ${OTHER.slice(0, 8)}] recovery for project ${PROJECT.slice(0, 8)}: done`,
      `cannot open /Users/ann/Designs/Client X/.git/index (EACCES) for ${PROJECT}`,
      `runtime directory /Users/ann/Library/Application Support/Draft Tide/runtime is not private`,
      `uncaught: at /Users/ann/other/file.js:1`,
      `pushed ${OID} for ANN-GH as 12+ann-gh@users.noreply.github.com, token ghu_abcdefghijklmnopqrstuvwx`,
      `operation ${OTHER} and again ${OTHER}`,
      `Client X saved; tab\there; bell\u0007 rtl‮`,
    ].join('\n');
    const out = redact(log);
    expect(out).toBe(
      [
        `2026-10-03T00:00:00.000Z [engine 42 ${OTHER.slice(0, 8)}] recovery for project project-1: done`,
        `cannot open <project-1 folder>/.git/index (EACCES) for project-1`,
        `runtime directory <private path>/runtime is not private`,
        `uncaught: at <private path>/other/file.js:1`,
        `pushed oid-1 for <github-account> as <email>, token <token>`,
        `operation id-1 and again id-1`,
        `<project-1 name> saved; tab\there; bell� rtl�`,
      ].join('\n'),
    );
  });

  it('replaces a short word only as a whole word, and never inside a label', () => {
    const { redact } = redactor();
    expect(redact('ab abc cab ab.')).toBe('<private name> abc cab <private name>.');
    // A project named "project": the labels that hold the word stay.
    const named = redactor({ words: ['project'] }).redact;
    expect(named(`project ${PROJECT}`)).toBe('<private name> project-1');
  });

  it('never lets a private value through, wherever it sits in the text', () => {
    // Private values from letters no label uses, so a match can only be a leak.
    const secret = fc.stringMatching(/^[QWXYZ][QWXYZ0-9 ]{2,15}[QWXYZ]$/);
    fc.assert(
      fc.property(
        fc.array(secret, { minLength: 1, maxLength: 4 }),
        fc.array(secret, { minLength: 1, maxLength: 4 }),
        fc.array(fc.string({ maxLength: 20 }), { maxLength: 8 }),
        (paths, words, filler) => {
          const { redact } = redactor({ paths: paths.map((p) => `/${p}`), words });
          const text = [...filler, ...paths.map((p) => `/${p}/x`), ...words].sort().join(' ');
          const out = redact(text);
          for (const p of paths) expect(out).not.toContain(`/${p}`);
          for (const w of words) expect(out.toLowerCase()).not.toContain(w.toLowerCase());
          expect(out).not.toContain(PROJECT);
        },
      ),
    );
  });

  it('labels projects and ids consistently within one report', () => {
    const labeler = createLabeler();
    expect(labeler.project(PROJECT)).toBe('project-1');
    expect(labeler.id(PROJECT)).toBe('project-1');
    expect(labeler.id(OTHER)).toBe('id-1');
    expect(labeler.id(OTHER.toUpperCase())).toBe('id-1');
    expect(labeler.knownProject(PROJECT.slice(0, 8))).toBe('project-1');
    expect(labeler.knownProject(OTHER.slice(0, 8))).toBeNull();
    expect(labeler.oid(OID)).toBe('oid-1');
  });
});
