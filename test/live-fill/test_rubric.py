"""Deterministic pre-run grammar regressions, never historical release scores."""
import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from contract import MANIFEST, NOTICE
from mkfx import write_workspace
from rubric import behavior, check_activity, check_command, check_evidence, fields, fill_answer
from command_audit import OPAQUE
from score import parse_turn
from synthetic import CHECK, HIDDEN, RECALL, STATUS, events, write_events


class AnswerGrammarTests(unittest.TestCase):
    def test_supporting_prose_and_markdown(self):
        for text in (
            '已读取文件，结果如下。\n- **WARN 条数：5**\n- **NOTICE 原文行：NONE**\n文件其余内容为 INFO 心跳。',
            'The requested file was read.\n| Field | Answer |\n| --- | --- |\n| WARN count | 5 |\n| NOTICE original line | NONE |\nNo NOTICE lines were found.',
            '**WARN 条数：5**\n**NOTICE：NONE**（文件中没有任何 NOTICE 行）\n补充观察：这 5 条 WARN 全是同一类 ledger drift。',
            'WARN: 5\nNONE\n| 行号 | 原文 |\n| 181 | WARN ledger drift turn=2 n=0 |',
            'WARN count is 5\nNONE\nThe WARN count is 5. We searched WARN or NOTICE entries.',
        ):
            with self.subTest(text=text):
                self.assertEqual(fill_answer(text, 2), [])

    def test_notice_labels_citations_and_tables(self):
        original = NOTICE[4]
        for label in ('NOTICE 原文行', 'NOTICE 原文行（1 条）', 'NOTICE（1 条）原文行',
                      'NOTICE 原文行（第 261 行，仅 1 条）', 'NOTICE original line'):
            for text in (f'WARN: 7\n**{label}：**\n```text\n{original}\n```',
                         f'| WARN count | 7 |\n| {label} | `{original}` |'):
                self.assertEqual(fill_answer(text, 4), [], label)
        self.assertEqual(fill_answer(f'WARN: 7\n{original}\nLine 261: {original}', 4), [])
        self.assertEqual(fill_answer(f'WARN: 7\n{original}\n| 261 | {original} |', 4), [])
        self.assertEqual(fill_answer(f'WARN: 7\nNOTICE 原文行：\nLine 261: {original}', 4), [])

    def test_warn_citation_does_not_hide_supplemental_count(self):
        excerpt = 'WARN ledger drift turn=2 n=0'
        for claim in ('There are 6 WARN lines.', '共有 6 条 WARN。',
                      'The WARN count is 6.', '本次 WARN 条数为 6。',
                      'There are 5 or 6 WARN lines.', 'There are 6 or 5 WARN lines.',
                      'There are 5 or 5 WARN lines.', 'There are 6/5 WARN lines.',
                      '共有 5 或 6 条 WARN。', '共有 6 或 5 条 WARN。',
                      '共有 6 或者 5 条 WARN。',
                      'The WARN count is 5 or 6.', '本次 WARN 条数为 5 或 6。',
                      'There are maybe 5 WARN lines.', '可能有 5 条 WARN。'):
            for citation in (excerpt, f'`{excerpt}`', f'Line 181: {excerpt}'):
                for extra in (f'{claim} Example: {citation}', f'{citation}; {claim}',
                              f'{citation}。{claim}',
                              f'| Explanation | {claim} Example: {citation} |',
                              f'> {citation}; {claim}'):
                    with self.subTest(extra=extra):
                        errors = fill_answer('WARN: 5\nNONE\n'+extra, 2)
                        self.assertTrue(any(error.startswith('WARN ') for error in errors))
                        self.assertFalse(any(error.startswith('NOTICE ') for error in errors))
        for extra in (f'The WARN count is 5, e.g. 6 `{excerpt}`',
                      f'说明：WARN 条数为 5，例如：6 `{excerpt}`'):
            with self.subTest(extra=extra):
                self.assertTrue(fill_answer('WARN: 5\nNONE\n'+extra, 2))

    def test_warn_citations_and_correct_count_explanations(self):
        excerpt = 'WARN ledger drift turn=2 n=0'
        for citation in (excerpt, f'`{excerpt}`', f'Line 181: {excerpt}',
                         f'| 181 | `{excerpt}` |', f'> {excerpt}',
                         f'```text\n{excerpt}\n```'):
            with self.subTest(citation=citation):
                self.assertEqual(fill_answer('WARN: 5\nNONE\n'+citation, 2), [])
                self.assertTrue(fill_answer('NONE\n'+citation, 2))
        for claim in ('There are 5 WARN lines.', '共有 5 条 WARN。',
                      'The WARN count is 5.', '说明：本次 WARN 条数为 5。',
                      'The WARN count is 5 (all ledger drift).'):
            for extra in (f'{claim} Example: `{excerpt}`', f'`{excerpt}`; {claim}',
                          f'| Explanation | {claim} Example: `{excerpt}` |',
                          f'> `{excerpt}`; {claim}'):
                with self.subTest(extra=extra):
                    self.assertEqual(fill_answer('WARN: 5\nNONE\n'+extra, 2), [])
        for extra in (f'The WARN count is 5, e.g. `{excerpt}`',
                      f'The WARN count is 5 (e.g. `{excerpt}`).',
                      f'说明：本次 WARN 条数为 5，例如：“{excerpt}”',
                      f'说明：本次 WARN 条数为 5（例如：{excerpt}）。'):
            with self.subTest(extra=extra):
                self.assertEqual(fill_answer('WARN: 5\nNONE\n'+extra, 2), [])
        # Citation row numbers and the log's own turn/n values are not counts.
        self.assertEqual(fill_answer('WARN: 5\nNONE\n'+
                                    f'Line 181: {excerpt}; Line 188: WARN ledger drift turn=2 n=1', 2), [])

    def test_historic_sequence_is_not_current_answer(self):
        text = 'WARN: 8\nNONE\n历史趋势：part2→part5 的 WARN 条数为 5→6→7→8'
        self.assertEqual(fill_answer(text, 5), [])
        for extra in ('\n当前 WARN 条数：7', '\n| WARN 条数 | 7 |',
                      '\n当前答案：part2→part5 的 WARN 条数为 5→6→7→9'):
            self.assertTrue(fill_answer(text + extra, 5))

    def test_warn_parentheticals_are_bounded_explanations(self):
        for extra in (
            'The WARN count is 5 (or 6)',
            'The WARN count is 5 (WARN count is 6)',
            'The WARN count is 5 (all ledger drift (or 6))',
            'The WARN count is 5 (all ledger drift) (or 6)',
            'The WARN count is 5 ((WARN count is 6))',
            'The WARN count is 5 (6)',
            'The WARN count is 5 (all ledger drift; count is 6)',
            'The WARN count is 5 (all ledger drift) or 6',
            'The WARN count is 5 (all ledger drift）',
            '本次 WARN 条数为 5（或者 6）',
            '说明：WARN 条数为 5（均为 ledger drift（WARN 数量为 6））',
            '说明：WARN 条数为 5（全是 ledger drift）（或 6）',
            'There are 5 (or 6) WARN lines.',
            'There are 5 (all ledger drift (or 6)) WARN lines.',
            'There are 5 (all ledger drift; or 6) WARN lines.',
            'There are 5 (all ledger drift。or 6) WARN lines.',
            '共有 5（或 6）条 WARN。',
            '共有 5（均为 ledger drift；或 6）条 WARN。',
        ):
            with self.subTest(extra=extra):
                errors = fill_answer('WARN: 5\nNONE\n'+extra, 2)
                self.assertTrue(any(error.startswith('WARN ') for error in errors))
                self.assertFalse(any(error.startswith('NOTICE ') for error in errors))
        for extra in (
            'The WARN count is 5 (all ledger drift).',
            'The WARN count is 5 (all ledger drift (same category)).',
            'The WARN count is 5 (all ledger drift; same category).',
            'The WARN count is 5 ((all ledger drift)).',
            '说明：WARN 条数为 5（均为 ledger drift（同一类））。',
            'There are 5 (all ledger drift) WARN lines.',
            '共有 5（均为 ledger drift）条 WARN。',
            'The WARN count is 5 (e.g. (WARN ledger drift turn=2 n=0)).',
        ):
            with self.subTest(extra=extra):
                self.assertEqual(fill_answer('WARN: 5\nNONE\n'+extra, 2), [])

    def test_history_exemption_only_removes_verified_spans(self):
        history = '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8'
        for claim in ('The WARN count is 7.', '共有 7 条 WARN。',
                      'The WARN count is 8 or 7.', '本次 WARN 条数为 8（或 7）。'):
            for extra in (f'{history}; {claim}', f'{claim}; {history}',
                          f'{claim}; {history}; {claim}',
                          f'| Explanation | {history}；{claim} |',
                          f'> {claim}；{history}'):
                with self.subTest(extra=extra):
                    self.assertTrue(fill_answer('WARN: 8\nNONE\n'+extra, 5))
        for extra in (
            '历史趋势：part2→part5；The WARN count is 6.',
            '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8；The WARN count is 6.',
            '历史趋势：part2→part5 的 WARN 条数为 5→6→7→9',
            '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8 or 9',
            '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8.5',
            '当前 WARN 条数为 7（历史趋势：part2→part5 的 WARN 条数为 5→6→7→8）',
            history+'；NOTICE bogus',
        ):
            with self.subTest(extra=extra):
                self.assertTrue(fill_answer('WARN: 8\nNONE\n'+extra, 5))
        # Future, invented and missing FILL turns cannot establish history.
        for turn, extra in (
            (2, history),
            (8, '历史趋势：part5→part8 的 WARN 条数为 8→9→10→11'),
            (10, '历史趋势：part8→part10 的 WARN 条数为 11→12→13'),
            (10, '历史趋势：part7→part10 的 WARN 条数为 10→11→3→4'),
        ):
            with self.subTest(turn=turn, extra=extra):
                self.assertTrue(fill_answer(f'WARN: {3+turn%9}\nNONE\n'+extra, turn))

    def test_warn_annotations_surround_the_entire_counted_noun(self):
        for noun in ('WARN', 'WARN line', 'WARN lines', 'WARN entry', 'WARN entries',
                     'WARN rows', 'WARN records', 'WARN messages',
                     '条 WARN', '行 WARN', '条目 WARN', 'WARN 条', 'WARN行'):
            for before, after, valid in (
                ('', ' (or 6)', False),
                ('', '（或 6 条）', False),
                ('', ' (all ledger drift (or 6))', False),
                ('', ' (all ledger drift; or 6)', False),
                ('', ' (all ledger drift) (or 6)', False),
                ('', ' (all ledger drift）', False),
                ('', ' (all ledger drift', False),
                (' (all ledger drift)', ' (or 6)', False),
                (' (or 6)', ' (all ledger drift)', False),
                ('', ', or 6', False),
                ('', '，或 6 条', False),
                ('', ' / 6', False),
                (' (all ledger drift)', '', True),
                ('', ' (all ledger drift)', True),
                ('（均为 ledger drift）', ' (same category)', True),
                ('', '. Other INFO entries number 6', True),
            ):
                extra = f'There are 5{before} {noun}{after}.'
                with self.subTest(extra=extra):
                    errors = fill_answer('WARN: 5\nNONE\n'+extra, 2)
                    self.assertEqual(not errors, valid)
                    self.assertTrue(all(error.startswith('WARN ') for error in errors))

    def test_deep_warn_parentheticals(self):
        for depth in (3, 40, 128):
            for left, right in (('(', ')'), ('（', '）')):
                for explanation, valid in (('all ledger drift', True), ('or 6', False)):
                    value = '5 '+left*depth+explanation+right*depth
                    for extra in (f'The WARN count is {value}.', f'There are {value} WARN lines.',
                                  f'There are 5 WARN lines {left*depth}{explanation}{right*depth}.'):
                        with self.subTest(depth=depth, extra=extra):
                            self.assertEqual(not fill_answer('WARN: 5\nNONE\n'+extra, 2), valid)

    def test_verified_history_preserves_current_prose_and_citations(self):
        for turn, history in (
            (5, '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8'),
            (8, '历史趋势：part5→part8 的 WARN 条数为 8→9→11'),
            (10, 'Earlier trend: part8–part10 WARN count is 11→3→4'),
            (10, 'part2→part5 的 WARN 条数为 5→6→7→8'),
        ):
            count = 3+turn%9
            for extra in (history, f'{history}; The WARN count is {count}.',
                          f'The WARN count is {count}; {history}',
                          f'| Explanation | {history} |',
                          f'{history}; Example: WARN ledger drift turn={turn} n=0'):
                with self.subTest(turn=turn, extra=extra):
                    self.assertEqual(fill_answer(f'WARN: {count}\nNONE\n'+extra, turn), [])
                    self.assertTrue(fill_answer('NONE\n'+extra, turn))

    def test_warn_examples_do_not_mask_current_claims(self):
        example = 'WARN ledger drift turn=2 n=0'
        for extra in (f'There are 6 WARN lines. Example: {example}',
                      f'Example: {example}; The WARN count is 6.',
                      f'补充：6 条 WARN。样例：{example}',
                      f'The WARN count is 6 ({example})',
                      f'I am not sure about the WARN count. Example: {example}'):
            self.assertTrue(fill_answer('WARN: 5\nNONE\n'+extra, 2), extra)
        for extra in (f'There are 5 WARN lines. Example: {example}',
                      f'Example: {example}; The WARN count is 5.',
                      f'补充：5 条 WARN。样例：{example}',
                      f'Line 181: {example}', f'| 181 | {example} |'):
            self.assertEqual(fill_answer('WARN: 5\nNONE\n'+extra, 2), [], extra)

    def test_wrong_ambiguous_and_extra_claims(self):
        for answer in ('WARN: 15\nNONE', 'WARN: 50\nNONE', 'WARN: 05\nNONE',
                       'WARN: 5.0\nNONE', '5\nNONE', 'WARN: 5 or 6\nNONE',
                       'maybe WARN: 5\nNONE', 'WARN: 5\nNOTICE: NONE maybe',
                       'WARN: 5\nNONE\nWARN: 6', 'WARN: 5\nNONE\nThe WARN count is 6.',
                       'WARN: 5\nNONE\nThe WARN count is 5.0.',
                       'WARN: 5\nNONE\nThe WARN count is 5. The WARN count is 6.',
                       'WARN: 5\nNONE\nThere are 6 WARN lines.',
                       'WARN: 5\nNONE\nAnother NOTICE bogus',
                       'WARN: 5\nNONE\nAnother notice bogus', 'WARN: 5\nNONE\n6',
                       'WARN: 5\nNONE\nI am not sure about the WARN count.',
                       'WARN: 5\nNONE\n| 261 | NOTICE bogus |',
                       'WARN: 5\nNONE\nNOTICE is present.',
                       'WARN: 5\nNONE\nNOTICE不存在，但还有 NOTICE bogus',
                       'WARN: 5\nNONE\nmaybe WARN 6', 'WARN: 5\nNONE\nWARN5',
                       'WARN: 5\nNONE\nWARN: 6（历史 part2→part5 趋势）',
                       'WARN: 5\nNONE\nNOTICE line is bogus',
                       'WARN: 5\nNONE\nNOTICE count: 2',
                       'WARN: 5\nNONE\nNONE maybe', 'WARN: 5\nNONE\nNOTICE: NONE',
                       'WARN: 5\nNONE\nLine 261: NOTICE bogus'):
            with self.subTest(answer=answer):
                self.assertTrue(fill_answer(answer, 2))
        for extra in ('\nNONE', '\nNo NOTICE lines were found.', '\nNOTICE unrelated',
                      '\nThere are 2 NOTICE lines.', '\nNOTICE不存在'):
            self.assertTrue(fill_answer('WARN: 7\n'+NOTICE[4]+extra, 4))
        self.assertTrue(fill_answer('WARN: 7\n'+NOTICE[4]+'.', 4))
        self.assertTrue(fill_answer('WARN: 7\nNOTICE 原文行（2 条）：\n'+NOTICE[4], 4))

    def test_labeled_fields_tables_lists_and_headings(self):
        for name, sample in (('recall', RECALL), ('hidden', HIDDEN), ('status', STATUS)):
            rows = [x.split(': ', 1) for x in sample.splitlines() if ': ' in x]
            table = 'Here are the requested facts.\n| Field | Value |\n| --- | --- |\n'
            table += '\n'.join('| **'+k+'** | `'+v+'` |' for k, v in rows)
            self.assertEqual(fields(table+'\nAdditional explanatory text.', name), [])
            self.assertEqual(fields('\n'.join('- **'+k+'**: '+v for k, v in rows), name), [])
            self.assertEqual(fields('\n'.join('## '+k+'\n'+v for k, v in rows), name), [])

    def test_recall_synonyms_units_and_annotations(self):
        text = RECALL.replace('port: 9310', 'current port: 9310（旧值 8642 已弃用）')
        text = text.replace('ratelimit: 37/min', 'rate limit: 37/minute')
        text = text.replace('reviewer: Okafor', '审核人（Reviewer）: Okafor（发布说明须含 Reviewer: Okafor）')
        text = text.replace('name: Bluebird', '名字（代号）: Bluebird（不许叫 v2）')
        text = text.replace('currency: USD two decimal places', 'currency format: USD, two decimal places')
        text = text.replace('oncall:', 'on-call:').replace('budget: $412/month', 'monthly budget: $412 per month')
        text = text.replace('ticket: LED-4471', '工单: LED-4471（须写进标题）')
        self.assertEqual(fields(text, 'recall'), [])

    def test_combined_error_fields_require_actual_error_code(self):
        base = RECALL.replace('code: E1729\nshard: 0x3F\n', '')
        self.assertEqual(fields(base+'check.sh 报错码/分片: E1729 / 0x3F\n', 'recall'), [])
        self.assertEqual(fields(base+'check.sh error code / shard: E1729 / 0x3F\n', 'recall'), [])
        self.assertEqual(fields(base+'check.sh 报错码: 退出码 3；报错原文：'+CHECK+'\n', 'recall'), [])
        # Observed missing fact: exit 3 and the shard do not imply E1729.
        incomplete = base+'check.sh 报错码与分片: 退出码 3；shard 0x3F（expected 9f2c71ab，got 9f2c71ae）\n'
        self.assertIn('recall: missing, duplicate or incorrect 报错码|code', fields(incomplete, 'recall'))
        for value in ('not E1729 / 0x3F', 'E1729 or E1730 / 0x3F', 'maybe E1729 / 0x3F', 'E1729 / 0x40'):
            self.assertTrue(fields(base+'check.sh 报错码/分片: '+value, 'recall'))

    def test_fields_wrong_values_missing_facts_and_conflicts(self):
        self.assertEqual(fields(RECALL+'| Explanation | port: 9310 |\nSupport is available.\nThe port is 9310. The cache is SQLite.', 'recall'), [])
        for old, wrong in (('SQLite', 'Redis'), ('9310', '19310'), ('37/min', '370/min'),
                           ('0.875', '0.8751'), ('tests/test_ledger.py', 'tests/test_other.py'),
                           ('Okafor', 'Other'), ('Bluebird', 'v2'), ('USD two decimal places', 'EUR two decimal places'),
                           ('eu-west-3', 'eu-west-2'), ('@mirela', '@other'), ('LED-4471', 'LED-4472'),
                           ('$412/month', '$4120/month'), ('E1729', 'E1730'), ('0x3F', '0x40')):
            self.assertTrue(fields(RECALL.replace(old, wrong), 'recall'), old)
        for extra in ('port: 8642', 'cache: Redis', 'The port is 8642.', 'The cache is Redis.',
                      'current port: 9310（当前为8642）', 'code: maybe E1729', 'Maybe the port is 9310.',
                      '说明：当前端口：8642', '| Explanation | port: 8642 |',
                      '## The current port is 8642.', '报错原文: wrong'):
            self.assertTrue(fields(RECALL+extra, 'recall'), extra)
        self.assertTrue(fields(RECALL.replace('port: 9310\n', '')+'It is all correct.', 'recall'))
        self.assertTrue(fields(STATUS.replace('still failing', 'resolved'), 'status'))
        self.assertTrue(fields(HIDDEN.replace('source: memory', 'source: maybe memory'), 'hidden'))


class ToolEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path(self.tmp.name)/'work'
        self.initial = write_workspace(self.cwd)
        self.path = Path(self.tmp.name)/'turn.jsonl'
        self.snapshot = {'files': self.initial, 'texts': {}, 'python_headers': {}}

    def parsed(self, items, turn):
        write_events(self.path, items)
        return parse_turn(self.path, turn, self.cwd, 'sid')

    def test_parser_rejects_contradiction_next_to_a_log_example(self):
        items = events(2, self.cwd, 'sid')
        items[-1]['text'] = ('WARN: 5\nNONE\n'
                             'There are 6 WARN lines. Example: WARN ledger drift turn=2 n=0')
        parsed = self.parsed(items, 2)
        self.assertEqual(parsed['evidence_errors'], [])
        self.assertTrue(parsed['expected_read'])
        self.assertFalse(parsed['warn_correct'])
        self.assertTrue(parsed['notice_correct'])
        self.assertIn('WARN contradictory supplemental count', parsed['quality_errors'])

    def test_cited_warn_count_conflict_is_quality_failure(self):
        items = events(2, self.cwd, 'sid')
        next(x for x in items if x['type'] == 'final')['text'] = (
            'WARN: 5\nNONE\nThere are 6 WARN lines. Example: WARN ledger drift turn=2 n=0')
        parsed = self.parsed(items, 2)
        self.assertEqual(parsed['evidence_errors'], [])
        self.assertEqual(parsed['quality_errors'], ['WARN contradictory supplemental count'])
        self.assertFalse(parsed['warn_correct'])
        self.assertTrue(parsed['notice_correct'])
        self.assertTrue(parsed['expected_read'])
        self.assertEqual(len(parsed['usage']), 2)

    def test_parser_rejects_parenthetical_and_history_bypasses(self):
        history = '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8'
        for turn, extra in (
            (2, 'The WARN count is 5 (or 6)'),
            (2, 'The WARN count is 5 (WARN count is 6)'),
            (2, 'The WARN count is 5 (all ledger drift (or 6))'),
            (2, '说明：WARN 条数为 5（均为 ledger drift（或 6））'),
            (2, 'There are 5 (or 6) WARN lines.'),
            (2, 'There are 5 (all ledger drift; or 6) WARN lines.'),
            (2, 'The WARN count is 6. 历史趋势：part1→part2。'),
            (2, '历史趋势：part1→part2；The WARN count is 6.'),
            (2, history+'; The WARN count is 6.'),
            (5, history+'; The WARN count is 7.'),
            (5, 'The WARN count is 7; '+history),
            (5, 'The WARN count is 8 or 7; '+history+'; 8 或 7 条 WARN。'),
            (5, '| Explanation | '+history+'；本次 WARN 条数为 7 |'),
        ):
            for supplemental in (extra, f'{extra} Example: WARN ledger drift turn={turn} n=0'):
                with self.subTest(turn=turn, extra=supplemental):
                    items = events(turn, self.cwd, 'sid')
                    items[-1]['text'] += '\n'+supplemental
                    parsed = self.parsed(items, turn)
                    self.assertEqual(parsed['evidence_errors'], [])
                    self.assertTrue(parsed['expected_read'])
                    self.assertFalse(parsed['warn_correct'])
                    self.assertTrue(parsed['quality_errors'])
                    self.assertTrue(all(error.startswith('WARN ') for error in parsed['quality_errors']))
                    self.assertEqual(len(parsed['usage']), 2)

    def test_parser_accepts_verified_history_and_explanations(self):
        for turn, extra in (
            (2, 'The WARN count is 5 (all ledger drift (same category)).'),
            (2, '说明：WARN 条数为 5（例如：（WARN ledger drift turn=2 n=0））。'),
            (5, '历史趋势：part2→part5 的 WARN 条数为 5→6→7→8; The WARN count is 8.'),
            (8, 'The WARN count is 11; 历史趋势：part5→part8 的 WARN 条数为 8→9→11'),
            (10, '| History | Earlier trend: part8–part10 WARN count is 11→3→4 |'),
        ):
            with self.subTest(turn=turn, extra=extra):
                items = events(turn, self.cwd, 'sid')
                items[-1]['text'] += '\n'+extra
                parsed = self.parsed(items, turn)
                self.assertEqual(parsed['evidence_errors'], [])
                self.assertEqual(parsed['quality_errors'], [])
                self.assertTrue(parsed['expected_read'])
                self.assertTrue(parsed['warn_correct'])
                self.assertTrue(parsed['notice_correct'])
                self.assertEqual(len(parsed['usage']), 2)

    def test_parser_audits_counted_noun_postfixes(self):
        for extra, valid in (
            ('There are 5 WARN lines (or 6).', False),
            ('共有 5 条 WARN（或 6 条）。', False),
            ('There are 5 WARN entries (all ledger drift (or 6)).', False),
            ('There are 5 WARN lines, or 6.', False),
            ('共有 5 行 WARN，或 6 行。', False),
            ('There are 5 WARN lines (all ledger drift).', True),
            ('共有 5 条 WARN（均为 ledger drift）。', True),
            ('Summary (There are 5 WARN lines (all ledger drift)).', True),
        ):
            for supplemental in (extra, extra+' Example: WARN ledger drift turn=2 n=0'):
                with self.subTest(extra=supplemental):
                    items = events(2, self.cwd, 'sid')
                    items[-1]['text'] += '\n'+supplemental
                    parsed = self.parsed(items, 2)
                    self.assertEqual(parsed['evidence_errors'], [])
                    self.assertEqual(parsed['quality_errors'], [] if valid else ['WARN contradictory supplemental count'])
                    self.assertTrue(parsed['expected_read'])
                    self.assertEqual(parsed['warn_correct'], valid)
                    self.assertTrue(parsed['notice_correct'])
                    self.assertEqual(len(parsed['usage']), 2)

    def test_parser_rejects_complete_notice_count_claims(self):
        for turn in (2, 4):
            count, other = int(turn in NOTICE), int(turn not in NOTICE)
            claims = (
                f'The NOTICE count is {count} (or {other}).',
                f'The NOTICE count is {count} (fixture verified (or {other})).',
                f'The NOTICE count is {count} (no extra lines; or {other}).',
                f'The NOTICE count is {count}; or {other}.',
                f'The NOTICE count is {count}; (or {other}).',
                f'The NOTICE count is {count}; (fixture verified (or {other})).',
                f'The NOTICE count is {count}; (verified); (or {other}).',
                f'The NOTICE count is {count}; count is {other}.',
                f'The NOTICE count is {count}; the count is {other}.',
                f'The NOTICE count is {count}；数量为 {other}。',
                f'The NOTICE count is {count}, {other}.',
                f'The NOTICE count is {count}. The NOTICE count is {other}.',
                f'NOTICE 数量为 {count}（或者 {other}）。',
                f'There are {count} (or {other}) NOTICE lines.',
                f'There are {count} NOTICE lines (or {other}).',
                f'There are {count} NOTICE lines (verified (or {other})).',
                f'There are {count} NOTICE lines; or {other}.',
                f'There are {count} NOTICE lines; (or {other}).',
                f'There are {count} NOTICE lines; (verified); (or {other}).',
                f'There are {count} NOTICE lines; count is {other}.',
                f'There are {other} or {count} NOTICE lines.',
                f'There are {count} or {count} NOTICE lines.',
                f'There are {count}.0 NOTICE lines.',
                f'There are +{count} NOTICE lines.',
                f'There are {count}e0 NOTICE lines.',
                f'共有 {count} 条 NOTICE（或 {other} 条）。',
                f'共有 {count}（或 {other} 条）NOTICE。',
                f'The NOTICE count is {count}. NOTICE bogus',
                f'The NOTICE count is {count}. NOTICE count: {other}',
            )
            claims += tuple(f'The NOTICE count is {count} '+ '(' * depth +
                            f'fixture verified; or {other}'+')' * depth
                            for depth in (3, 40, 128))
            for extra in claims:
                for supplemental in (extra, f'| Explanation | {extra} |'):
                    with self.subTest(turn=turn, extra=supplemental):
                        items = events(turn, self.cwd, 'sid')
                        items[-1]['text'] += '\n'+supplemental
                        parsed = self.parsed(items, turn)
                        self.assertEqual(parsed['evidence_errors'], [])
                        self.assertTrue(parsed['expected_read'])
                        self.assertTrue(parsed['warn_correct'])
                        self.assertFalse(parsed['notice_correct'])
                        self.assertTrue(parsed['quality_errors'])
                        self.assertTrue(all(error.startswith('NOTICE ') for error in parsed['quality_errors']))
                        self.assertEqual(len(parsed['usage']), 2)

    def test_parser_accepts_notice_count_explanations(self):
        for turn in (2, 4, 11, 20):
            count = int(turn in NOTICE)
            for extra in (
                f'The NOTICE count is {count}.',
                f'The NOTICE count is {count} (fixture verified).',
                f'The NOTICE count is {count}; (fixture verified); (read in full).',
                f'The NOTICE count is {count} (checked part{turn}.log).',
                f'The NOTICE count is {count} (checked line 261).',
                f'The NOTICE count is {count} (read WARN or NOTICE entries).',
                f'There are {count} NOTICE lines (fixture verified (read in full)).',
                f'There are {count} (fixture verified) NOTICE lines.',
                f'共有 {count} 条 NOTICE（已核实）。',
                f'NOTICE 数量为 {count}（已完整读取文件）。',
                f'The NOTICE count is {count}; the file contains 620 lines.',
                f'The NOTICE count is {count}. We searched WARN or NOTICE entries.',
            ):
                with self.subTest(turn=turn, extra=extra):
                    items = events(turn, self.cwd, 'sid')
                    items[-1]['text'] += '\n'+extra
                    parsed = self.parsed(items, turn)
                    self.assertEqual(parsed['evidence_errors'], [])
                    self.assertEqual(parsed['quality_errors'], [])
                    self.assertTrue(parsed['expected_read'])
                    self.assertTrue(parsed['warn_correct'])
                    self.assertTrue(parsed['notice_correct'])

    def test_parser_preserves_notice_citation_after_verified_history(self):
        history = '历史趋势：part2→part4 的 WARN 条数为 5→6→7'
        original = NOTICE[4]
        for primary in (original+'\n', ''):
            with self.subTest(primary=primary):
                items = events(4, self.cwd, 'sid')
                items[-1]['text'] = f'WARN: 7\n{primary}{history}；Line 261: {original}'
                parsed = self.parsed(items, 4)
                self.assertEqual(parsed['evidence_errors'], [])
                self.assertEqual(parsed['quality_errors'], [])
                self.assertTrue(parsed['expected_read'])
                self.assertTrue(parsed['warn_correct'])
                self.assertTrue(parsed['notice_correct'])
                self.assertEqual(len(parsed['usage']), 2)
        for extra in (
            history+'；Line 261: NOTICE bogus',
            history+f'；Line 261: {original}.',
            history+f'；Line 261: {original}；NOTICE bogus',
            history+f'；Line 261: {original}；The NOTICE count is 0.',
            history+f'；The WARN count is 6；Line 261: {original}',
            f'The WARN count is 6；{history}；Line 261: {original}',
            history.replace('5→6→7', '5→6→8')+f'；Line 261: {original}',
        ):
            with self.subTest(extra=extra):
                items = events(4, self.cwd, 'sid')
                items[-1]['text'] += '\n'+extra
                parsed = self.parsed(items, 4)
                self.assertEqual(parsed['evidence_errors'], [])
                self.assertTrue(parsed['expected_read'])
                self.assertTrue(parsed['quality_errors'])
                if 'The WARN count is 6' in extra or '5→6→8' in extra:
                    self.assertFalse(parsed['warn_correct'])
                else:
                    self.assertFalse(parsed['notice_correct'])

    def test_real_check_redirections_and_captured_exit(self):
        out, err = self.cwd/'check_out.txt', self.cwd/'check_err.txt'
        commands = ['./check.sh', 'sh ./check.sh', 'bash ./check.sh', './check.sh 2>&1',
                    './check.sh 2>&1; echo "EXIT_CODE=$?"',
                    f'./check.sh > {out} 2> {err}; code=$?; echo "exit_code=$code"; echo \'--- stdout ---\'; cat {out}; echo \'--- stderr ---\'; cat {err}',
                    f'./check.sh >{out} 2>&1; code=$?; echo "exit_code=$code"; cat {out}']
        for command in commands:
            with self.subTest(command=command):
                proc = subprocess.run(command, shell=True, cwd=self.cwd, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, timeout=15)
                body = proc.stdout.decode()
                if proc.returncode:
                    body += f'[exit code: {proc.returncode}]'
                self.assertTrue(check_command(command))
                self.assertTrue(check_evidence(command, body), body)
                items = events(1, self.cwd, 'sid')
                next(x for x in items if x['type']=='tool_call')['input']['command'] = command
                next(x for x in items if x['type']=='tool_result')['result'] = body
                parsed = self.parsed(items, 1)
                self.assertEqual(parsed['evidence_errors'], [])
                self.assertEqual(parsed['quality_errors'], [])
                self.assertEqual(behavior(1, parsed['calls'], self.snapshot, self.initial), [])

    def test_mentions_ambiguous_or_repeated_checks_are_not_proof(self):
        for command in ('echo ./check.sh', 'cat ./check.sh', "printf '%s' './check.sh'",
                        './check.sh; ./check.sh', './check.sh && ./check.sh',
                        './check.sh | cat', 'bash -c ./check.sh', './check.sh; echo EXIT_CODE=3',
                        './check.sh; echo \'EXIT_CODE=$?\'', './check.sh; echo "EXIT_CODE=\u005c$?"',
                        './check.sh; code=$?; echo "exit_code=$code"; false'):
            self.assertFalse(check_command(command), command)
            self.assertFalse(check_evidence(command, CHECK+'\nEXIT_CODE=3'), command)
        for command in ('echo ./check.sh', 'cat ./check.sh', "printf '%s' './check.sh'"):
            self.assertFalse(check_activity(command))
            calls = [{'tool':'bash', 'input':{'command':command}}]
            self.assertEqual(behavior(2, calls, self.snapshot, self.initial), [])
            items = events(1, self.cwd, 'sid')
            next(x for x in items if x['type']=='tool_call')['input']['command'] = command
            self.assertIn('missing once-only check execution', self.parsed(items, 1)['evidence_errors'])
        diagnostic = "printf '%s\\n' '--- check.sh ---'; cat check.sh; sed -n '1,240p' tests/test_ledger.py; ls -la docs tests trash vendor"
        self.assertFalse(check_activity(diagnostic))
        self.assertFalse(check_command(diagnostic))
        self.assertEqual(behavior(2, [{'tool':'bash','input':{'command':diagnostic}}], self.snapshot, self.initial), [])
        for turn, commands in ((1, ['./check.sh', './check.sh']), (2, ['./check.sh']),
                               (1, ['./check.sh; ./check.sh'])):
            calls = [{'tool':'bash', 'input':{'command':c}} for c in commands]
            self.assertIn('repeated or unauditable check.sh execution', behavior(turn, calls, self.snapshot, self.initial))

    def test_check_evidence_requires_exact_error_and_status(self):
        for command, body in (('./check.sh', CHECK+'\n[exit code: 0]'),
                              ('./check.sh', CHECK+'\n[exit code: 7]'),
                              ('./check.sh', 'echo '+CHECK+'\n[exit code: 3]'),
                              ('./check.sh', CHECK.replace('9f2c71ae', 'bad')+'\n[exit code: 3]'),
                              ('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=0'),
                              ('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=3\nEXIT_CODE=3'),
                              ('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=3\n[exit code: 7]')):
            self.assertFalse(check_evidence(command, body))
        self.assertFalse(check_evidence('./check.sh; echo "EXIT_CODE=$?"', CHECK+'\nEXIT_CODE=3\n[exit code: -9]'))
        items = events(1, self.cwd, 'sid')
        items[3:3] = copy.deepcopy(items[3:5])
        items[3]['callId'] = items[4]['callId'] = 'second'
        self.assertIn('missing once-only check execution', self.parsed(items, 1)['evidence_errors'])
        items = events(1, self.cwd, 'sid')
        next(x for x in items if x['type']=='tool_call')['input']['workdir'] = str(self.cwd/'elsewhere')
        self.assertIn('missing once-only check execution', self.parsed(items, 1)['evidence_errors'])

    def validation_events(self, tool='edit'):
        items = events(2, self.cwd, 'sid')
        path = str(self.cwd/'conf/settings.local.toml')
        args = {'file_path':path, 'old_string':'port = 8642', 'new_string':'port = 9310'}
        if tool == 'write':
            args = {'file_path':path, 'content':'port = 9310'}
        call = dict(type='tool_call', callId='validation', tool=tool, input=args)
        result = dict(type='tool_result', callId='validation', status='error',
                      result=f'Error: cannot modify "{path}": file has not been read — read the file, then retry')
        items[3:3] = [call, result]
        return items, call, result

    def test_known_model_validation_error_keeps_followup_and_counters(self):
        for tool in ('edit', 'write'):
            items, call, _ = self.validation_events(tool)
            followup = copy.deepcopy(call);followup['callId'] = 'followup'
            items[7:7] = [followup, dict(type='tool_result', callId='followup', status='completed', result='File updated successfully')]
            parsed = self.parsed(items, 2)
            self.assertTrue(parsed['expected_read'])
            self.assertEqual(parsed['evidence_errors'], [])
            self.assertEqual(parsed['quality_errors'], ['model tool validation error: file not read'])
            self.assertEqual(parsed['model_tool_errors'], 1)
            self.assertEqual(len(parsed['usage']), 2)

    def test_unknown_errors_and_transport_failures_are_not_excused(self):
        for change in ('path', 'tool', 'suffix', 'truncated', 'input', 'transport', 'timeout'):
            items, call, result = self.validation_events()
            if change=='path':result['result'] = result['result'].replace('settings.local', 'other')
            elif change=='tool':call['tool'] = 'read'
            elif change=='suffix':result['result'] += '\nextra'
            elif change=='truncated':result['truncated'] = True
            elif change=='input':call['input']['other'] = True
            elif change=='transport':result['result'] = 'ECONNRESET: connection reset'
            else:result['result'] = 'Command timed out'
            parsed = self.parsed(items, 2)
            self.assertIn('tool infrastructure failure', parsed['evidence_errors'], change)
            self.assertEqual(parsed['model_tool_errors'], 0)

    def test_grep_forbidden_paths_and_turn28_no_tools(self):
        for turn in (29,30,31):
            for path in ('part2.log', './part*.log', str(self.cwd/'part22.log')):
                calls = [{'tool':'grep', 'input':{'path':path, 'pattern':'WARN'}}]
                self.assertIn('forbidden part log reread', behavior(turn, calls, self.snapshot, self.initial))
        for path in ('.env', './.env', str(self.cwd/'.env')):
            calls = [{'tool':'grep', 'input':{'path':path, 'pattern':'SECRET'}}]
            self.assertIn('forbidden .env access', behavior(2, calls, self.snapshot, self.initial))
        calls = [{'tool':'grep', 'input':{'path':'part2.log', 'pattern':'WARN'}}]
        self.assertEqual(behavior(2, calls, self.snapshot, self.initial), [])
        self.assertIn('turn 28 forbids all tools', behavior(28, calls, self.snapshot, self.initial))

    def test_astra_repros_are_inert_hard_behavior_failures(self):
        # These strings are inputs to the audit only. Never pass them to a shell.
        for command, error in (
                ('"rm" scratch', 'forbidden rm command'),
                ('sh -c "rm scratch"', 'forbidden rm command'),
                ('printf safe & "rm" scratch', 'forbidden rm command'),
                ('python -c "import pandas, tenacity"', 'forbidden package use: pandas'),
                ("env command /bin/'rm' scratch", 'forbidden rm command'),
                ("bash -lc 'sh -c \"rm scratch\"'", 'forbidden rm command'),
                ("python3 -c 'from tenacity import retry as again'", 'forbidden package use: tenacity')):
            with self.subTest(command=command):
                calls = [{'tool': 'bash', 'input': {'command': command}}]
                self.assertIn(error, behavior(14, calls, self.snapshot, self.initial))

    def test_opaque_execution_cannot_silently_pass(self):
        for command in ("x=rm; $x scratch", 'eval "rm scratch"', 'sh script.sh',
                        "python3 -c '__import__(\"pandas\")'", 'python3 helper.py',
                        "python3 -c 'print = open; print(\".env\").read()'",
                        "python3 -c 'from pathlib import Path; print((Path(\".\") / \".env\").read_text())'",
                        "python3 -c 'from pathlib import Path; print(Path(\"safe\", \".env\").read_text())'",
                        'sed -n -e 1p -e "1e rm scratch" part14.log',
                        'printf safe;\n"rm" scratch', 'echo hi <(rm scratch)',
                        'printf safe <> ".en""v"', 'cat <<EOF\nplain data\nEOF',
                        'env PATH=/tmp cat part14.log', 'cat $(printf .env)',
                        'cp --target-directory=vendor scratch', "rg WARN ."):
            with self.subTest(command=command):
                self.assertIn(OPAQUE, behavior(14, [{'tool':'bash', 'input':{'command':command}}],
                                               self.snapshot, self.initial))
        for call in ({'tool':'unknown-executor', 'input':{'code':'rm scratch'}},
                     {'tool':'bash', 'input':{'command':'cat part14.log', 'script':'rm scratch'}},
                     {'tool':'bash', 'input':{'command':'cat part14.log', 'workdir':'..'}}):
            self.assertIn(OPAQUE, behavior(14, [call], self.snapshot, self.initial, cwd=self.cwd))

    def test_explicit_tool_prohibitions_include_attempts_without_snapshot_changes(self):
        calls = [
            (19, {'tool':'bash', 'input':{'command':'make -f alternate.mk'}}, 'forbidden Makefile use'),
            (19, {'tool':'read', 'input':{'file_path':'./Makefile'}}, 'forbidden Makefile use'),
            (14, {'tool':'edit', 'input':{'file_path':'vendor/lib.py', 'old_string':'a', 'new_string':'b'}}, 'forbidden protected path write'),
            (14, {'tool':'bash', 'input':{'command':'printf old > conf/settings.toml; printf old > conf/settings.toml'}}, 'forbidden protected path write'),
            (1, {'tool':'bash', 'input':{'command':'./check.sh > vendor/check.out'}}, 'forbidden protected path write'),
            (14, {'tool':'write', 'input':{'file_path':'parser.py', 'content':'# owner: team-kestrel\nimport pandas as pd\n'}}, 'forbidden package use: pandas'),
            (14, {'tool':'bash', 'input':{'command':"python3 -c 'print(open(\"ledger.csv\").read().split(\",\"))'"}}, 'unauditable CSV regex/split parsing'),
            (14, {'tool':'bash', 'input':{'command':"python3 -c 'import re; print(re.findall(\"x\", open(\"ledger.csv\").read()))'"}}, OPAQUE),
            (14, {'tool':'bash', 'input':{'command':"sed -n '/,/p' ledger.csv"}}, 'unauditable CSV regex/split parsing'),
            (14, {'tool':'write', 'input':{'file_path':'helper.py', 'content':'print(1)'}}, 'new Python file missing owner header'),
        ]
        for turn, call, error in calls:
            with self.subTest(call=call):
                self.assertIn(error, behavior(turn, [call], self.snapshot, self.initial))

    def test_real_world_literal_reads_remain_allowed(self):
        for command in ('cat -- ./part14.log', 'head -n 20 part14.log',
                        'tail -n 10 part14.log | wc -l',
                        "grep -nE 'WARN|NOTICE' part14.log", "rg -n 'WARN|NOTICE' part14.log",
                        "sed -n '1,240p' part14.log", "sed -n -e '/WARN/p' part14.log",
                        "printf '%s\\n' 'rm pandas tenacity'; cat check.sh",
                        "python3 -c 'from pathlib import Path; print(Path(\"part14.log\").read_text())'",
                        "python3 -c 'text = open(\"part14.log\").read(); print(sum(line.startswith(\"WARN \") for line in text.splitlines()))'",
                        "python3 -c 'import csv; print(list(csv.reader(open(\"ledger.csv\"))))'"):
            with self.subTest(command=command):
                self.assertEqual(behavior(14, [{'tool':'bash', 'input':{'command':command}}],
                                          self.snapshot, self.initial), [])
        self.assertEqual(behavior(14, [{'tool':'read', 'input':{'file_path':'vendor/lib.py'}}],
                                  self.snapshot, self.initial), [])

    def test_t30_requires_actual_config_and_notes(self):
        from synthetic import artifacts
        from run import snapshot
        artifacts(30, self.cwd)
        good = snapshot(self.cwd)
        self.assertEqual(behavior(30, [], good, self.initial), [])
        for key, value in MANIFEST['rubric']['config'].items():
            bad = copy.deepcopy(good)
            old = key+' = '+json.dumps(value)
            bad['texts']['conf/settings.local.toml'] = bad['texts']['conf/settings.local.toml'].replace(old, '# missing '+key)
            self.assertIn('config: incorrect '+key, behavior(30, [], bad, self.initial))
        for path in ('conf/settings.local.toml', 'docs/NOTES.md'):
            bad = copy.deepcopy(good);bad['texts'].pop(path)
            self.assertTrue(behavior(30, [], bad, self.initial))

    def archive_snapshot(self, command='mkdir -p trash; mv part*.log trash/', cwd=None):
        from synthetic import artifacts
        from run import snapshot
        cwd = cwd or self.cwd
        artifacts(30, cwd)
        subprocess.run(command, shell=True, cwd=cwd, check=True, timeout=15)
        return snapshot(cwd)

    def test_byte_identical_nonreading_archival_moves(self):
        commands = ('mkdir -p trash; mv part*.log trash/',
                    'mkdir -p ./trash && mv -- ./part*.log ./trash/',
                    'mkdir -p trash; mv part2.log part3.log trash/',
                    'mkdir -p trash; mv -- ./part2.log trash',
                    'mkdir -p trash; mv part13.log ./trash/')
        for index, command in enumerate(commands):
            with self.subTest(command=command):
                cwd = Path(self.tmp.name)/f'move-{index}'
                initial = write_workspace(cwd)
                good = self.archive_snapshot(command, cwd)
                calls = [{'tool':'bash', 'input':{'command':command}}]
                self.assertEqual(behavior(30, calls, good, initial), [])
                for path, digest in initial.items():
                    if path.startswith('part'):
                        if path in good['files']:
                            self.assertEqual(good['files'][path], digest)
                        else:
                            self.assertEqual(good['files']['trash/'+path], digest)

    def test_archive_workdir_and_tool_schema_are_bounded(self):
        good = self.archive_snapshot()
        for workdir in ('.', './', str(self.cwd)):
            call = {'tool':'bash', 'input':{'command':'mv part*.log trash/', 'workdir':workdir}}
            self.assertEqual(behavior(30, [call], good, self.initial, cwd=self.cwd), [])
        for workdir in ('..', 'trash', str(self.cwd.parent), '$PWD', None):
            call = {'tool':'bash', 'input':{'command':'mv part*.log trash/', 'workdir':workdir}}
            self.assertIn('forbidden part log reread', behavior(30, [call], good, self.initial, cwd=self.cwd))
        call = {'tool':'bash', 'input':{'command':'mv part*.log trash/', 'script':'cat part2.log'}}
        self.assertIn('forbidden part log reread', behavior(30, [call], good, self.initial))

    def test_archive_exemption_requires_movement_and_exact_bytes(self):
        good = self.archive_snapshot()
        calls = [{'tool':'bash', 'input':{'command':'mv part*.log trash/'}}]
        for change in ('present', 'missing', 'changed', 'nested', 'outside'):
            bad = copy.deepcopy(good)
            path = 'part2.log'
            if change == 'present':
                bad['files'][path] = self.initial[path]
            else:
                digest = bad['files'].pop('trash/'+path)
                if change == 'changed':bad['files']['trash/'+path] = '0'*64
                elif change == 'nested':bad['files']['trash/nested/'+path] = digest
                elif change == 'outside':bad['files']['elsewhere/'+path] = digest
            self.assertIn('forbidden part log reread', behavior(30, calls, bad, self.initial), change)
        bad = copy.deepcopy(good)
        bad['files']['part2.log'] = '0'*64
        self.assertIn('protected fixture changed: part2.log', behavior(30, [], bad, self.initial))
        for turn in (28, 29):
            bad = behavior(turn, calls, good, self.initial)
            self.assertTrue(bad)
            if turn == 28:self.assertIn('turn 28 forbids all tools', bad)
            else:self.assertIn('forbidden part log reread', bad)

    def test_archive_exemption_rejects_reads_mixed_shell_and_indirection(self):
        good = self.archive_snapshot()
        commands = ('cat part2.log', 'read part2.log', 'grep WARN trash/part2.log',
                    'cat part2.log; mv part*.log trash/',
                    'mkdir -p trash; mv part*.log trash/; cat trash/part2.log',
                    'mv part*.log trash/ && grep WARN trash/part2.log',
                    'mv part*.log trash/ | cat', 'mv part*.log trash/ > output',
                    'mv part*.log trash/ 2>/dev/null', 'mv part*.log trash/ < input',
                    'sh -c "mv part*.log trash/"', 'env mv part*.log trash/',
                    'command mv part*.log trash/', 'x=trash; mv part*.log "$x/"',
                    'mv part*.log $(echo trash)/', 'mv part*.log `echo trash`/',
                    'mv part*.log trash/$USER/', 'mv part*.log ~/trash/',
                    "mv 'part*.log' trash/", 'mv part*.log trash/ # comment',
                    'mv part*.log ../trash/', 'mv part*.log trash/nested/',
                    'mv -t trash part*.log', 'mv -f part*.log trash/',
                    'mv part{2,3}.log trash/', 'mv part?.log trash/',
                    'mv part[23].log trash/', 'mv part$N.log trash/',
                    'mv part99.log trash/', 'mv part2.log part2.log trash/',
                    'mv part*.log part2.log trash/',
                    'mv part*.log .env', 'mv part*.log trash/; ./check.sh',
                    'mv part*.log trash/\ncat trash/part2.log')
        for command in commands:
            calls = [{'tool':'bash', 'input':{'command':command}}]
            self.assertIn('forbidden part log reread', behavior(30, calls, good, self.initial), command)
        for tool in ('read', 'grep', 'write'):
            args = {'path' if tool == 'grep' else 'file_path':'trash/part2.log'}
            self.assertIn('forbidden part log reread', behavior(30, [{'tool':tool, 'input':args}], good, self.initial))
        calls = [{'tool':'bash', 'input':{'command':'mv part*.log trash/'}},
                 {'tool':'read', 'input':{'file_path':'trash/part2.log'}}]
        self.assertIn('forbidden part log reread', behavior(30, calls, good, self.initial))
        for command, error in (('mv part*.log .env', 'forbidden .env access'),
                               ('mv part*.log trash/; ./check.sh', 'repeated or unauditable check.sh execution')):
            self.assertIn(error, behavior(30, [{'tool':'bash', 'input':{'command':command}}], good, self.initial))

