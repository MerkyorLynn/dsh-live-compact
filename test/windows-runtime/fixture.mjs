import './network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sha256 } from './common.mjs';

const [dshAnchor, replayAnchor, replayEntry, workspace, output] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(file).href);
const { Session } = await load(createRequire(dshAnchor).resolve('@deepseek-ai/dsh-session'));
const { sessionFormatCatalog } = await load(createRequire(replayAnchor).resolve('@deepseek-ai/dsh-session-format-catalog'));
const { parseSessionLog } = await load(replayEntry);
const synthetic = Session.create('synthetic-runtime-fixture');
const header = { ...synthetic.header, createdAt: 0, cwd: workspace, delegationDepth: 0 };
writeFileSync(output, JSON.stringify(sessionFormatCatalog.encodeCurrentHeader(header, 0)) + '\n');
assert.deepEqual(parseSessionLog(readFileSync(output, 'utf8')), []);
console.log(JSON.stringify({ format: header.version, fixtureSha256: sha256(readFileSync(output)), streams: 3 }));
