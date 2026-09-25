import type { ArchiveRecord, FieldKey, MatchCandidate, RecordGroup, RevisionChange } from '../types';
import { scorePair } from './matching';

export interface RevisionRow {
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
}

export interface RevisionDuplicate {
  identifier: string;
  rows: number[];
}

export interface RevisionUpdate {
  recordId: string;
  identifier: string;
  row: RevisionRow;
  changes: RevisionChange[];
}

export interface RevisionPlan {
  added: ArchiveRecord[];
  updated: RevisionUpdate[];
  unchanged: number;
}

export type RevisionOutcome =
  | { ok: true; plan: RevisionPlan }
  | { ok: false; duplicates: RevisionDuplicate[] };

const toList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(/[，,、]/).map((item) => item.trim()).filter(Boolean);
};

export const normalizeRow = (row: Record<string, unknown>): RevisionRow => ({
  title: String(row.title ?? '').trim() || '未命名记录',
  date: String(row.date ?? '').trim(),
  people: toList(row.people),
  places: toList(row.places),
  identifier: String(row.identifier ?? '').trim(),
  medium: String(row.medium ?? '').trim(),
  extent: String(row.extent ?? '').trim(),
  rights: String(row.rights ?? '').trim(),
  notes: String(row.notes ?? '').trim()
});

const comparators: Array<[Exclude<FieldKey, 'identifier'>, (record: ArchiveRecord) => string, (row: RevisionRow) => string]> = [
  ['title', (record) => record.title, (row) => row.title],
  ['date', (record) => record.date, (row) => row.date],
  ['people', (record) => record.people.join('、'), (row) => row.people.join('、')],
  ['places', (record) => record.places.join('、'), (row) => row.places.join('、')],
  ['medium', (record) => record.medium, (row) => row.medium],
  ['extent', (record) => record.extent, (row) => row.extent],
  ['rights', (record) => record.rights, (row) => row.rights],
  ['notes', (record) => record.notes, (row) => row.notes]
];

export const diffRecord = (record: ArchiveRecord, row: RevisionRow): RevisionChange[] =>
  comparators
    .map(([field, fromRecord, fromRow]) => ({ field, before: fromRecord(record), after: fromRow(row) }))
    .filter((change) => change.before !== change.after);

const findDuplicates = (rows: RevisionRow[]): RevisionDuplicate[] => {
  const positions = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (!row.identifier) return;
    const list = positions.get(row.identifier) ?? [];
    list.push(index + 1);
    positions.set(row.identifier, list);
  });
  return [...positions.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([identifier, lines]) => ({ identifier, rows: lines }));
};

export function planRevision(records: ArchiveRecord[], group: RecordGroup, rows: RevisionRow[], at: string): RevisionOutcome {
  const duplicates = findDuplicates(rows);
  if (duplicates.length) return { ok: false, duplicates };
  const plan: RevisionPlan = { added: [], updated: [], unchanged: 0 };
  rows.forEach((row) => {
    const existing = row.identifier
      ? records.find((record) => record.group === group && record.identifier === row.identifier)
      : undefined;
    if (!existing) {
      plan.added.push({ ...row, id: crypto.randomUUID(), group, updatedAt: at, status: 'unreviewed' });
      return;
    }
    const changes = diffRecord(existing, row);
    if (changes.length) plan.updated.push({ recordId: existing.id, identifier: row.identifier, row, changes });
    else plan.unchanged += 1;
  });
  return { ok: true, plan };
}

export function applyUpdate(record: ArchiveRecord, update: RevisionUpdate, at: string, source: string) {
  update.changes.forEach(({ field }) => {
    if (field === 'people') record.people = [...update.row.people];
    else if (field === 'places') record.places = [...update.row.places];
    else record[field] = update.row[field];
  });
  record.updatedAt = at;
  record.revision = { at, source, changes: update.changes };
  record.status = 'unreviewed';
}

export function rematchAffected(records: ArchiveRecord[], existing: MatchCandidate[], affectedIds: Set<string>): MatchCandidate[] {
  const kept = existing.filter((match) => !affectedIds.has(match.leftId) && !affectedIds.has(match.rightId));
  const fresh: MatchCandidate[] = [];
  records.filter((record) => affectedIds.has(record.id)).forEach((record) => {
    const pool = records.filter((candidate) => candidate.group !== record.group);
    pool
      .map((candidate) => ({ candidate, ...scorePair(record, candidate) }))
      .filter((item) => item.score >= .38)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .forEach(({ candidate, score, fieldScores, reasons }) => {
        const left = record.group === 'A' ? record : candidate;
        const right = record.group === 'A' ? candidate : record;
        fresh.push({
          id: `match-${left.id}-${right.id}`,
          leftId: left.id,
          rightId: right.id,
          score,
          fieldScores,
          status: 'suggested',
          reasons
        });
      });
  });
  return [...kept, ...fresh].sort((a, b) => b.score - a.score);
}
