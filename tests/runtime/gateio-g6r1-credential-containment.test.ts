/** Synthetic credentials only: fake filesystem probes plus isolated native directory-link fixtures. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { GateIoCanaryCredentialError, isInsideGateIoGitWorktree, readGateIoCanaryCredentialFile,
  type GateIoCredentialFileAccess } from '../../src/runtime/gateio/GateIoCanaryCredentialFile';

const root = path.join(tmpdir(), 'g6r1-repo');
const other = path.join(tmpdir(), 'g6r1-other worktree 中文');
const outside = path.join(tmpdir(), 'g6r1-protected');
const journal = path.join(outside, 'events.jsonl');
const content = JSON.stringify({ apiKey: 'OFFLINE_G6R1_KEY', secretKey: 'OFFLINE_G6R1_SECRET' });

function fixture(aliases = new Map<string, string>()) {
  let reads = 0;
  const canonicalized: string[] = [];
  const gitCalls: string[][] = [];
  const access: GateIoCredentialFileAccess = {
    realpath(value) { canonicalized.push(value); return aliases.get(value) ?? value; },
    stat: () => ({ isFile: () => true, size: content.length }),
    readText() { reads++; return content; },
  };
  const git = (args: string[]) => {
    gitCalls.push(args);
    if (args[0] === 'rev-parse') return root;
    assert.deepEqual(args, ['worktree', 'list', '--porcelain', '-z']);
    return `worktree ${root}\0HEAD ${'a'.repeat(40)}\0\0worktree ${other}\0HEAD ${'b'.repeat(40)}\0\0`;
  };
  return { access, git, canonicalized, gitCalls, get reads() { return reads; } };
}

describe('G6R1 credential realpath containment before content read', () => {
  for (const [label, file] of [
    ['tracked file', path.join(root, 'secret.json')],
    ['ignored file', path.join(root, '.ignored', 'secret.json')],
    ['different linked worktree', path.join(other, 'secret.json')],
    ['equal root', root],
  ]) it(`${label} is rejected before reading any content`, () => {
    const f = fixture();
    assert.throws(() => readGateIoCanaryCredentialFile(file, journal, f.git, f.access),
      (error: unknown) => error instanceof GateIoCanaryCredentialError && error.code === 'CREDENTIAL_INSIDE_GIT_WORKTREE');
    assert.equal(f.reads, 0); assert.ok(f.canonicalized.includes(root)); assert.ok(f.canonicalized.includes(other));
  });
  it('outside protected file is accepted after enumerating/canonicalizing every root', () => {
    const f = fixture(); const file = path.join(outside, 'secret.json');
    assert.deepEqual(readGateIoCanaryCredentialFile(file, journal, f.git, f.access), JSON.parse(content));
    assert.equal(f.reads, 1); assert.ok(f.canonicalized.includes(other));
    assert.ok(f.gitCalls.some(args => args.includes('-z')));
  });
  it('same string prefix outside the repository is not a descendant', () => {
    const f = fixture();
    assert.ok(readGateIoCanaryCredentialFile(path.join(root + '-outside', 'secret.json'), journal, f.git, f.access));
    assert.equal(f.reads, 1);
  });
  it('outside symlink resolving inside a worktree is rejected', () => {
    const alias = path.join(outside, 'alias.json'); const target = path.join(other, 'secret.json');
    const f = fixture(new Map([[alias, target]]));
    assert.throws(() => readGateIoCanaryCredentialFile(alias, journal, f.git, f.access), /CREDENTIAL_INSIDE_GIT_WORKTREE/);
    assert.equal(f.reads, 0);
  });
  it('inside symlink resolving outside all worktrees reads only the canonical outside file', () => {
    const alias = path.join(root, '.ignored', 'alias.json'), target = path.join(outside, 'secret.json');
    const f = fixture(new Map([[alias, target]])); let actual: string | undefined;
    const read = f.access.readText;
    f.access.readText = value => { actual = value; return read(value); };
    assert.ok(readGateIoCanaryCredentialFile(alias, journal, f.git, f.access));
    assert.equal(actual, target); assert.equal(f.reads, 1);
  });
  it('worktree root aliases are also canonicalized', () => {
    const target = path.join(tmpdir(), 'actual-linked-root');
    const f = fixture(new Map([[other, target]]));
    assert.throws(() => readGateIoCanaryCredentialFile(path.join(target, 'secret.json'), journal, f.git, f.access),
      /CREDENTIAL_INSIDE_GIT_WORKTREE/); assert.equal(f.reads, 0);
  });
  it('current root remains protected even if omitted from the listing', () => {
    const f = fixture();
    const git = (args: string[]) => args[0] === 'rev-parse' ? root : `worktree ${other}\0\0`;
    assert.throws(() => readGateIoCanaryCredentialFile(path.join(root, 'secret.json'), journal, git, f.access),
      /CREDENTIAL_INSIDE_GIT_WORKTREE/); assert.equal(f.reads, 0);
  });
  it('unknown/missing worktree cannot silently reduce the protected set', () => {
    const f = fixture();
    f.access.realpath = value => { if (value === other) throw new Error('raw path ' + other); return value; };
    assert.throws(() => readGateIoCanaryCredentialFile(path.join(outside, 'secret.json'), journal, f.git, f.access),
      /CREDENTIAL_CONTAINMENT_UNVERIFIED/); assert.equal(f.reads, 0);
  });
  it('empty or non-absolute Git root evidence fails closed before read', () => {
    for (const listing of ['', 'worktree relative-root\0\0']) {
      const f = fixture(); const git = (args: string[]) => args[0] === 'rev-parse' ? root : listing;
      assert.throws(() => readGateIoCanaryCredentialFile(path.join(outside, 'secret.json'), journal, git, f.access),
        /CREDENTIAL_CONTAINMENT_UNVERIFIED/); assert.equal(f.reads, 0);
    }
  });
  it('canonical journal aliases cannot be used as credential files', () => {
    const alias = path.join(outside, 'alias.json'), f = fixture(new Map([[alias, journal]]));
    assert.throws(() => readGateIoCanaryCredentialFile(alias, journal, f.git, f.access), /EXPLICIT_CREDENTIAL_FILE_REQUIRED/);
    assert.equal(f.reads, 0);
  });
  it('malformed content errors never expose paths, JSON, secret fragments or metadata', () => {
    const f = fixture(), file = path.join(outside, 'secret.json');
    f.access.readText = () => { throw new Error(file + content + ' SIGN headers raw body'); };
    try { readGateIoCanaryCredentialFile(file, journal, f.git, f.access); assert.fail('expected denial'); }
    catch (error) {
      assert.ok(error instanceof GateIoCanaryCredentialError);
      const serialized = JSON.stringify(error) + String(error);
      for (const forbidden of [file, 'apiKey', 'secretKey', 'OFFLINE_G6R1_SECRET', 'SIGN', 'headers', 'raw body'])
        assert.equal(serialized.includes(forbidden), false);
    }
  });
  it('missing/relative file paths never enter filesystem or Git discovery', () => {
    for (const file of [undefined, 'relative.json']) {
      const f = fixture();
      assert.throws(() => readGateIoCanaryCredentialFile(file, journal, f.git, f.access), /EXPLICIT_CREDENTIAL_FILE_REQUIRED/);
      assert.equal(f.reads, 0); assert.equal(f.gitCalls.length, 0); assert.equal(f.canonicalized.length, 0);
    }
  });
  it('Windows case, mixed separators, sibling prefixes and different drives use path semantics', () => {
    assert.equal(isInsideGateIoGitWorktree('e:/WORK/repo/.ignored/key.json', 'E:\\work\\Repo', path.win32), true);
    assert.equal(isInsideGateIoGitWorktree('E:\\WORK\\REPO', 'e:/work/repo', path.win32), true);
    assert.equal(isInsideGateIoGitWorktree('E:/work/repository/key.json', 'E:/work/repo', path.win32), false);
    assert.equal(isInsideGateIoGitWorktree('F:/work/repo/key.json', 'E:/work/repo', path.win32), false);
    assert.equal(isInsideGateIoGitWorktree('E:/work/repo/../outside/key.json', 'E:/work/repo', path.win32), false);
  });
  it('native realpath enforces both directory-link directions before the actual fixture read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'g6r1-native-links-'));
    const repo = path.join(dir, 'repo'), external = path.join(dir, 'external');
    mkdirSync(repo); mkdirSync(external);
    const nativeJournal = path.join(external, 'journal.jsonl');
    writeFileSync(nativeJournal, 'offline journal fixture');
    writeFileSync(path.join(repo, 'secret.json'), content);
    writeFileSync(path.join(external, 'secret.json'), content);
    // Directory junctions need no privileged Windows file-symlink capability.
    const inward = path.join(external, 'inward'), outward = path.join(repo, 'outward');
    symlinkSync(repo, inward, process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(external, outward, process.platform === 'win32' ? 'junction' : 'dir');
    let reads = 0;
    const access: GateIoCredentialFileAccess = { realpath: realpathSync.native, stat: statSync,
      readText: file => { reads++; return readFileSync(file, 'utf8'); } };
    const git = (args: string[]) => args[0] === 'rev-parse' ? repo : `worktree ${repo}\0\0`;
    assert.throws(() => readGateIoCanaryCredentialFile(path.join(inward, 'secret.json'), nativeJournal, git, access),
      /CREDENTIAL_INSIDE_GIT_WORKTREE/); assert.equal(reads, 0);
    assert.deepEqual(readGateIoCanaryCredentialFile(path.join(outward, 'secret.json'), nativeJournal, git, access), JSON.parse(content));
    assert.equal(reads, 1);
  });
});
