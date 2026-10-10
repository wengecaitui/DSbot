import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(resolve('package.json'));
const { sprintf, vsprintf } = require('sprintf-js');

test('sprintf precision payloads do not abort an asynchronous operation', () => {
  const child = spawnSync(process.execPath, ['-e', `
    const { sprintf } = require('sprintf-js');
    setImmediate(() => {
      for (const type of ['e', 'f', 'g']) {
        for (const precision of ['101', '999999', '9'.repeat(4096)]) {
          const formatted = sprintf('%.' + precision + type, 1.25);
          if (formatted.length > 110) process.exit(2);
        }
      }
      sprintf('%.0g', 1.25);
      console.log('operation survived');
    });
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /operation survived/);
});

test('sprintf preserves valid formats and safely saturates numeric precision', () => {
  assert.equal(sprintf('%.2f', 1.25), '1.25');
  assert.equal(sprintf('%.0f', 1.25), '1');
  assert.equal(sprintf('%.0s', 'abc'), '');
  assert.equal(sprintf('%2$s %1$04d', 7, 'item'), 'item 0007');
  assert.equal(sprintf('%(item.name)s', { item: { name: 'safe' } }), 'safe');
  assert.equal(vsprintf('%s:%d', ['item', 7]), 'item:7');
  assert.equal(sprintf('%.2g', '1.25'), '1.3');
  for (const type of ['e', 'f', 'g']) {
    assert.equal(sprintf(`%.101${type}`, 1.25), sprintf(`%.100${type}`, 1.25));
  }
  assert.equal(sprintf('%.0g', 1.25), sprintf('%.1g', 1.25));
});

test('every locked sprintf consumer resolves to the repaired source', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const consumers = Object.entries(lock.packages).filter(([directory, pkg]: any) => directory.startsWith('node_modules/') && pkg.dependencies?.['sprintf-js']);
  assert.equal(consumers.length, 5, 'review coverage if the dependency tree changes');
  for (const [directory] of consumers) {
    const consumerRequire = createRequire(resolve(directory, 'package.json'));
    assert.equal(consumerRequire('sprintf-js/package.json').name, '@dsbot/sprintf-js', directory);
    assert.equal(consumerRequire.resolve('sprintf-js'), require.resolve('sprintf-js'), directory);
    assert.doesNotThrow(() => consumerRequire('sprintf-js').sprintf('%.101f', 1.25), directory);
  }
});

test('Roarr formats the precision payload without throwing', () => {
  const roarrRequire = createRequire(require.resolve('roarr/package.json'));
  roarrRequire('roarr');
  const createLogger = roarrRequire('./dist/factories/createLogger').default;
  const messages: any[] = [];
  const logger = createLogger((message: any) => messages.push(message), {});
  logger({ safe: true }, '%.101f', 1.25);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, sprintf('%.100f', 1.25));
  assert.equal(messages[0].context.safe, true);
});

test('Mammoth and its argparse 1.x remain compatible with the repaired formatter', async () => {
  const mammothRequire = createRequire(require.resolve('mammoth/package.json'));
  const { ArgumentParser } = mammothRequire('argparse');
  const parser = new ArgumentParser({ prog: 'formatter-check', addHelp: false });
  parser.addArgument(['-n'], { type: 'int' });
  assert.equal(parser.parseArgs(['-n', '7']).n, 7);
  assert.match(parser.formatHelp(), /formatter-check/);
  const { Document, Packer, Paragraph } = require('docx');
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('security regression')] }] }));
  const result = await require('mammoth').extractRawText({ buffer });
  assert.equal(result.value.trim(), 'security regression');
});

test('proxy-addr rejects the IPv4-mapped short-prefix trust bypass', () => {
  const proxyaddr = require('proxy-addr');
  for (const subnets of [['::ffff:10.0.0.0/8'], ['::ffff:10.0.0.0/8', '127.0.0.0/8'], ['::/1']]) {
    const trust = proxyaddr.compile(subnets);
    assert.equal(trust('203.0.113.5'), false);
    assert.equal(trust('::ffff:203.0.113.5'), false);
    const req = { socket: { remoteAddress: '203.0.113.5' }, headers: { 'x-forwarded-for': '10.0.0.1' } };
    assert.equal(proxyaddr(req, trust), '203.0.113.5');
  }
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('10.1.2.3'), true);
    assert.equal(trust('203.0.113.5'), false);
  }
});

test('sharp uses patched librsvg and still processes SVG images', async () => {
  const sharp = require('sharp');
  if (sharp.versions.rsvg) {
    const version = sharp.versions.rsvg.split('.').map(Number);
    assert.ok(version[0] > 2 || (version[0] === 2 && (version[1] > 63 || (version[1] === 63 && version[2] >= 2))), sharp.versions.rsvg);
  }
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>');
  const { data, info } = await sharp(svg).resize(8, 8).png().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 8);
  assert.equal(info.height, 8);
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
});

test('fast-copy retains cycle support and rejects hostile nesting with a depth guard', () => {
  const { default: copy } = require('fast-copy');
  const input: any = { nested: { value: 1 } };
  input.self = input;
  const output = copy(input);
  assert.notEqual(output, input);
  assert.notEqual(output.nested, input.nested);
  assert.equal(output.self, output);
  let nested: any = {};
  for (let depth = 0; depth < 4000; depth++) nested = { nested };
  assert.throws(() => copy(nested), (error: any) => error instanceof RangeError && error.name === 'MaxDepthExceededError');
});

test('music-metadata still parses valid PCM audio after parser security updates', async () => {
  // Dynamic import is needed because music-metadata is ESM-only.
  const metadata = await import('music-metadata');
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  const result = await metadata.parseBuffer(wav, { mimeType: 'audio/wav' });
  assert.equal(result.format.container, 'WAVE');
  assert.equal(result.format.sampleRate, 8000);
});

test('source-map-js rejects section offsets that would stall map generation', () => {
  const { SourceMapConsumer, SourceMapGenerator } = require('source-map-js');
  const map = { version: 3, sources: ['input.js'], names: [], mappings: 'AAAA' };
  for (const line of [Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => new SourceMapConsumer({ version: 3, sections: [{ offset: { line, column: 0 }, map }] }), /offset/i);
  }
  const consumer = new SourceMapConsumer({ version: 3, sections: [{ offset: { line: 2, column: 0 }, map }] });
  const generator = new SourceMapGenerator();
  consumer.eachMapping((mapping: any) => generator.addMapping({
    source: mapping.source,
    original: { line: mapping.originalLine, column: mapping.originalColumn },
    generated: { line: mapping.generatedLine, column: mapping.generatedColumn },
  }));
  assert.equal(generator.toJSON().mappings, ';;AAAA');
});
