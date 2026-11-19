import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, historyAnchor, serialize } from './core.mjs';
import { downloadPdf, loadBase } from './network.mjs';
import { calendarRemoteDatasetSchema } from '../calendar-schema.mjs';

const validate = (value) => calendarRemoteDatasetSchema.parse(value);
const checkedAt = '2026-11-18T12:00:00.000Z';
function fixture() {
  const existing = {
    schemaVersion: 1,
    timezone: 'UTC',
    updatedAt: '2026-10-01T00:00:00.000Z',
    coverage: { from: '2026-09-01', to: '2026-10-29' },
    events: [
      {
        id: 'history',
        title: 'Full Moon',
        category: 'full-moon',
        allDay: true,
        date: '2026-09-26',
      },
      {
        id: 'history2',
        title: 'Full Moon',
        category: 'full-moon',
        allDay: true,
        date: '2026-10-26',
      },
    ],
  };
  const names = {};
  for (const [category, count] of [
    ['boss', 4],
    ['champion', 3],
    ['flash-quest', 1],
  ])
    for (let i = 0; i < count; i++)
      names[`${category}${i}`] = { category, definitionId: `${category}:${i}` };
  const profile = { names, boundaryCategories: ['flash-quest'] };
  const dates = Array.from({ length: 31 }, (_, i) =>
    new Date(Date.parse('2026-11-18') + i * 86400000).toISOString().slice(0, 10),
  );
  const events = dates.flatMap((date) =>
    Object.entries(names).map(([canonicalName, definition]) => ({
      id: `pdf:${definition.definitionId}:${date}`,
      canonicalName,
      ...definition,
      date,
      timeUtc: definition.category === 'flash-quest' ? '15:00' : '00:00',
      confidence: 'confirmed',
    })),
  );
  const extraction = {
    extractorVersion: 1,
    sourceUrl: 'https://example.com',
    sourceSha256: 'fixture',
    pdfPages: 44,
    referenceNames: Object.keys(names),
    coveredDates: dates,
    coverage: { from: dates[0], to: dates.at(-1) },
    events,
    ambiguities: [
      {
        reason: 'start-versus-end-marker-unproven',
        canonicalName: 'flash-quest0',
        ...names['flash-quest0'],
        timeUtc: '14:00',
        date: dates[0],
      },
    ],
    nonEventMarkers: [],
    license: { reviewRequired: true },
    statistics: {
      calendarPages: 1,
      acceptedEvents: events.length,
      imagePlacements: dates.length * 18,
      recognizedImagePlacements: dates.length * 18,
      duplicateEventsIgnored: 0,
    },
  };
  const policy = {
    minimumBossesPerDay: 4,
    minimumChampionsPerDay: 3,
    bootstrapAnchor: historyAnchor(existing.events, '2026-11-18'),
  };
  const run = (base = existing, input = extraction, time = checkedAt, state = null) =>
    analyze(base, input, time, validate, profile, state, policy);
  return { existing, extraction, profile, policy, run };
}

test('adds the reliable window while retaining history, gaps and known exclusions', () => {
  const { existing, run } = fixture();
  const before = structuredClone(existing);
  const result = run();
  assert.deepEqual(existing, before);
  assert.equal(result.report.status, 'valid');
  assert.equal(result.report.newEvents, 248);
  assert.equal(result.report.uncoveredDates.length, 19);
  assert.equal(result.report.deletedEvents, 0);
  assert.equal(result.report.excludedEvents, 1);
  assert.deepEqual(
    result.candidate.events.find((e) => e.id === 'history'),
    existing.events[0],
  );
});
test('no-change weekly runs are idempotent without timestamp-only updates', () => {
  const { run } = fixture();
  const first = run();
  const repeated = run(first.candidate, undefined, '2026-11-25T12:00:00.000Z', first.coverageState);
  assert.equal(repeated.report.changed, false);
  assert.equal(repeated.report.newEvents, 0);
  assert.deepEqual(repeated.candidate, first.candidate);
  assert.equal(repeated.report.uncoveredDates.length, 19);
});
test('corrects a unique future hour while preserving its original ID', () => {
  const { extraction, run } = fixture();
  const first = run();
  const next = structuredClone(extraction);
  const item = next.events.find((e) => e.date === '2026-12-01' && e.canonicalName === 'boss0');
  item.timeUtc = '01:00';
  const revised = run(first.candidate, next, checkedAt, first.coverageState);
  assert.equal(revised.report.status, 'valid');
  assert.equal(revised.report.modifiedEvents, 1);
  assert.equal(revised.report.newEvents, 0);
  assert.equal(revised.report.corrections[0].revised.id, item.id);
});
test('historical changes and an incomplete historical base are refused', () => {
  const { existing, extraction, run } = fixture();
  const first = run();
  const next = structuredClone(extraction);
  next.events.find((e) => e.date === '2026-11-18' && e.canonicalName === 'boss0').timeUtc = '01:00';
  assert.equal(run(first.candidate, next, checkedAt, first.coverageState).report.status, 'refused');
  const reduced = structuredClone(existing);
  reduced.events.pop();
  assert.ok(run(reduced).report.blockers.includes('historical-anchor-mismatch'));
});
test('duplicates, unknown images, partial pages, unknown definitions and major count drops fail closed', () => {
  const { extraction, run } = fixture();
  for (const change of [
    (e) => e.events.push(e.events[0]),
    (e) => e.ambiguities.push({ reason: 'unknown-or-conflicting-image' }),
    (e) => e.referenceNames.pop(),
    (e) => (e.events[0].canonicalName = 'unmapped'),
    (e) => e.events.splice(0, 50),
    (e) => e.statistics.recognizedImagePlacements--,
  ]) {
    const input = structuredClone(extraction);
    change(input);
    assert.equal(run(undefined, input).report.status, 'refused');
  }
});
test('missing previously published future events are retained but refuse the update', () => {
  const { extraction, run } = fixture();
  const first = run();
  const input = structuredClone(extraction);
  input.events = input.events.filter(
    (e) => !(e.date === '2026-12-01' && e.canonicalName === 'boss0'),
  );
  input.statistics.acceptedEvents = input.events.length;
  const result = run(first.candidate, input, checkedAt, first.coverageState);
  assert.ok(result.report.blockers.includes('previous-future-events-missing-from-source'));
  assert.equal(result.candidate.events.length, first.candidate.events.length);
});
test('November to December remains explicitly UTC without invented durations', () => {
  const result = fixture().run();
  const item = result.candidate.events.find((e) => e.id === 'pdf:flash-quest:0:2026-12-01');
  assert.equal(item.startsAt, '2026-12-01T15:00:00.000Z');
  assert.equal(item.endsAt, undefined);
});
test('a corrected future start cannot silently reuse an unproven old end', () => {
  const { extraction, run } = fixture();
  const first = run();
  const previous = first.candidate.events.find((e) => e.id === 'pdf:boss:0:2026-12-01');
  previous.endsAt = '2026-12-02T00:00:00.000Z';
  const next = structuredClone(extraction);
  next.events.find((e) => e.id === previous.id).timeUtc = '02:00';
  const revised = run(first.candidate, next, checkedAt, first.coverageState);
  assert.ok(revised.report.blockers.includes('future-end-boundary-not-proven'));
});

test('anonymous PDF download validates MIME/signature/EOF and never transmits authorization', async () => {
  const bytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n');
  const data = await downloadPdf(
    async (_url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
    },
    async () => {},
  );
  assert.deepEqual(data, bytes);
});
test('unavailable, HTML and incomplete PDFs are refused after bounded attempts', async () => {
  for (const response of [
    () => new Response('error', { status: 503 }),
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('%PDF-1.7\ntruncated', { headers: { 'content-type': 'application/pdf' } }),
  ]) {
    let attempts = 0;
    await assert.rejects(() =>
      downloadPdf(
        async () => {
          attempts++;
          return response();
        },
        async () => {},
      ),
    );
    assert.equal(attempts, 2);
  }
});

