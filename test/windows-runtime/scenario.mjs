import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const payload = 'SYNTHETIC_RUNTIME_BEGIN\n' + Array.from({ length: 180 }, (_, i) => `INFO synthetic heartbeat ${String(i).padStart(4, '0')} status=ok ${'sample '.repeat(8)}`).join('\n') + '\nSYNTHETIC_RUNTIME_END\n';
export function replayEntries(stage) {
  const entry = (block) => ({ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: block.type },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } },
  ] });
  return [
    entry({ type: 'tool-call', id: `${stage}-long`, name: 'read', arguments: JSON.stringify({ file_path: 'synthetic.log', limit: 200 }) }),
    entry({ type: 'tool-call', id: `${stage}-after`, name: 'read', arguments: JSON.stringify({ file_path: 'control.txt' }) }),
    entry({ type: 'text', text: `SYNTHETIC_FINAL_${stage}` }),
  ];
}

export function overlay(replayEntry, fixture, script) {
  const q = JSON.stringify;
  // Patches replace the targeted config in full. Paid adapters and auxiliary
  // title/search model calls are disabled, and the preload forbids sockets.
  const disabled = ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'web-search-deepseek', 'tool-web'];
  return disabled.map((id) => `- id: ${id}\n  disabled: true\n`).join('') + `
- id: agent-default-model
  config:
    provider: synthetic-replay
    model: synthetic-runtime
- id: compaction-spine
  config:
    auto: false
    takeoverPresets: false
    minTokens: 0
- id: tool-result-pruner
  config:
    thresholdChars: 1024
    headChars: 256
    tailChars: 128
- insert:
    - id: runtime-official-replay
      name: ${q(replayEntry)}
      config:
        file: ${q(fixture)}
        overrideFile: ${q(script)}
        providers:
          - id: synthetic-replay
            name: Synthetic replay only
            models:
              - id: synthetic-runtime
                contextWindow: 128000
`;
}

export function writeInputs(workspace) {
  writeFileSync(join(workspace, 'synthetic.log'), payload);
  writeFileSync(join(workspace, 'control.txt'), 'SYNTHETIC_AFTER_DENIAL_CONTROL\n');
}
