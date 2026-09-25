import { seedRecords } from '../src/data/seed';
import { computeMatches } from '../src/utils/matching';
import { applyUpdate, normalizeRow, planRevision, rematchAffected } from '../src/utils/revision';
import type { ArchiveRecord, MatchCandidate } from '../src/types';

let failures = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`  ok - ${name}`);
  else { failures += 1; console.log(`  FAIL - ${name}`, extra ?? ''); }
};

const now = new Date().toISOString();

// 初始状态：种子记录 + 首轮匹配，人工处理一部分结论
const records: ArchiveRecord[] = seedRecords();
let matches: MatchCandidate[] = computeMatches(records);
const confirmed = matches.find((m) => m.leftId === 'a-001')!;
confirmed.status = 'confirmed';
confirmed.reviewedAt = now;
const rejected = matches.find((m) => m.leftId === 'a-002')!;
rejected.status = 'rejected';
rejected.reviewedAt = now;
const recordCount = records.length;

console.log('场景 1：修订表有改有留有新增');
const rows = [
  // a-001 改标题和数量
  normalizeRow({ title: '李秀珍口述史访谈（修订）', date: '2019-04-12', people: '李秀珍、周明远', places: '临河县、河口村', identifier: 'OH-LXZ-2019-01', medium: '数字录音', extent: '02:15:02', rights: '研究者授权', notes: '访谈共三个音频文件' }),
  // a-002 完全不变
  normalizeRow({ title: '渡口船工王德海回忆', date: '2017-09-03', people: '王德海', places: '白沙镇、老渡口', identifier: 'MS-WDH-17', medium: '手稿扫描', extent: '18页', rights: '家属授权', notes: '第三页有手写补记' }),
  // 新编号
  normalizeRow({ title: '新采集的访谈', date: '2024-01-01', people: '新人', places: '新地点', identifier: 'OH-NEW-2024-01', medium: '数字录音', extent: '1小时', rights: '待定', notes: '' })
];
const outcome = planRevision(records, 'A', rows, now);
if (outcome.ok) {
  const { plan } = outcome;
  check('新增 1 条', plan.added.length === 1, plan.added.length);
  check('修订 1 条', plan.updated.length === 1, plan.updated.length);
  check('沿用 1 条', plan.unchanged === 1, plan.unchanged);
  const update = plan.updated[0];
  check('只检出标题和数量两个差异字段', update.changes.length === 2 && update.changes.every((c) => c.title !== '' && ['title', 'extent'].includes(c.field)), update.changes);
  check('差异保留改前改后', update.changes[0].before === '李秀珍口述史访谈' && update.changes[0].after === '李秀珍口述史访谈（修订）', update.changes[0]);

  const target = records.find((r) => r.id === update.recordId)!;
  const notesBefore = target.notes;
  applyUpdate(target, update, now, '修订表A.tsv');
  check('只写入差异字段，备注保持不变', target.notes === notesBefore && target.title === '李秀珍口述史访谈（修订）' && target.extent === '02:15:02');
  check('记录旁保留改前改后', target.revision?.changes.length === 2 && target.revision.source === '修订表A.tsv');
  check('变更记录退回未核对', target.status === 'unreviewed');

  plan.added.forEach((r) => records.push(r));
  const affected = new Set([...plan.updated.map((u) => u.recordId), ...plan.added.map((r) => r.id)]);
  matches = rematchAffected(records, matches, affected);
  check('不追加重复卡片', records.length === recordCount + 1, records.length);
  const touched = matches.filter((m) => m.leftId === 'a-001' || m.rightId === 'a-001');
  check('变更记录的匹配退回待复核', touched.length > 0 && touched.every((m) => m.status === 'suggested'), touched.map((m) => m.status));
  const keptRejected = matches.find((m) => m.id === rejected.id);
  check('无变化的忽略结论沿用', keptRejected?.status === 'rejected', keptRejected?.status);
  const goneConfirmed = matches.find((m) => m.id === confirmed.id);
  check('被变更波及的确认结论已重算为待复核', !goneConfirmed || goneConfirmed.status === 'suggested');
  const newRecordMatches = matches.filter((m) => m.leftId === plan.added[0].id || m.rightId === plan.added[0].id);
  check('新编号记录进入匹配队列', newRecordMatches.every((m) => m.status === 'suggested'));
} else {
  check('场景 1 应通过校验', false, outcome.duplicates);
}

console.log('场景 2：同一文件内编号重复，整份拒绝');
const dupRows = [
  normalizeRow({ title: '甲', identifier: 'OH-DUP-01' }),
  normalizeRow({ title: '乙', identifier: 'OH-OTHER-01' }),
  normalizeRow({ title: '丙', identifier: 'OH-DUP-01' }),
  normalizeRow({ title: '丁', identifier: '' }),
  normalizeRow({ title: '戊', identifier: '' })
];
const dupOutcome = planRevision(records, 'A', dupRows, now);
check('重复编号被拒绝', !dupOutcome.ok);
if (!dupOutcome.ok) {
  check('指出重复位置（第 1、3 行）', dupOutcome.duplicates.length === 1 && dupOutcome.duplicates[0].identifier === 'OH-DUP-01' && dupOutcome.duplicates[0].rows.join(',') === '1,3', dupOutcome.duplicates);
  check('空编号不算重复', !dupOutcome.duplicates.some((d) => d.identifier === ''));
}

console.log('场景 3：再次导入相同内容，全部沿用');
const again = planRevision(records, 'A', rows, now);
if (again.ok) {
  check('已修订的记录不再重复写入', again.plan.updated.length === 0, again.plan.updated);
  check('新编号第二次导入变为沿用', again.plan.unchanged === 3, again.plan.unchanged);
  check('没有新增', again.plan.added.length === 0, again.plan.added.length);
} else {
  check('场景 3 应通过校验', false, again.duplicates);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
