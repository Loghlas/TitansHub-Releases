import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { reviewOfficial } from './official.mjs';
import { analyze, historyAnchor, serialize } from './core.mjs';
import { isOfficialForecast } from './official-assertions.mjs';
import {
  calendarRemoteDatasetSchema,
  remoteCalendarDatasetToOccurrences,
} from '../calendar-schema.mjs';
const manifest = JSON.parse(
  await readFile(new URL('./official-november-2026.json', import.meta.url)),
);
const validate = (value) => calendarRemoteDatasetSchema.parse(value);
const now = '2026-11-19T00:10:00.000Z';
function fixture() {
  const events = [
    { id: 'history', category: 'full-moon', title: 'Full Moon', allDay: true, date: '2026-09-26' },
    {
      id: 'dragon',
      category: 'dragon-invasion',
      title: 'Dragon Invasion',
      definitionId: 'dragon-invasion:dragon-invasion',
      allDay: false,
      startsAt: '2026-11-19T15:00:00.000Z',
    },
    {
      id: 'king',
      category: 'guest-champion',
      title: 'Reinhold',
      definitionId: 'guest-champion:reinhold',
      allDay: false,
      startsAt: '2026-11-18T00:00:00.000Z',
    },
    {
      id: 'gold',
      category: 'lost-city-of-gold',
      title: 'Lost City of Gold',
      definitionId: 'lost-city-of-gold:lost-city-of-gold',
      allDay: false,
      startsAt: '2026-11-27T15:00:00.000Z',
    },
    {
      id: 'dec-dragon',
      category: 'dragon-invasion',
      title: 'Dragon Invasion',
      definitionId: 'dragon-invasion:dragon-invasion',
      allDay: false,
      startsAt: '2026-12-17T15:00:00.000Z',
    },
    {
      id: 'dec-king',
      category: 'guest-champion',
      title: 'Reinhold',
      definitionId: 'guest-champion:reinhold',
      allDay: false,
      startsAt: '2026-12-16T00:00:00.000Z',
    },
  ];
  const calendar = {
    schemaVersion: 1,
    timezone: 'UTC',
    updatedAt: '2026-11-18T00:00:00.000Z',
    coverage: { from: '2026-09-01', to: '2026-12-18' },
    events,
  };
  const state = {
    schemaVersion: 1,
    coveredRanges: [
      { from: '2026-09-01', to: '2026-10-29' },
      { from: '2026-11-18', to: '2026-12-18' },
    ],
    historyAnchor: historyAnchor(events, '2026-11-18'),
  };
  return { calendar, state };
}
const review = () => {
  const f = fixture();
  return { ...f, ...reviewOfficial(f.calendar, f.state, manifest, now, validate) };
};
test('official Dragon date wins without UTC hour, end or duplicate; ID is stable', () => {
  const r = review(),
    e = r.candidate.events.find((e) => e.id === 'dragon');
  assert.equal(e.date, '2026-11-20');
  assert.equal(e.allDay, true);
  assert.equal(e.startsAt, undefined);
  assert.equal(e.endsAt, undefined);
  assert.equal(e.durationDays, undefined);
  assert.equal(
    r.candidate.events.filter(
      (e) => e.category === 'dragon-invasion' && (e.date ?? e.startsAt).startsWith('2026-11'),
    ).length,
    1,
  );
  assert.equal(r.report.blockers.length, 0);
});
test('King keeps only official start date; end date stays in ledger with unknown boundary', () => {
  const r = review(),
    e = r.candidate.events.find((e) => e.id === 'king');
  assert.equal(e.date, '2026-11-09');
  assert.equal(e.startsAt, undefined);
  const a = r.coverageState.officialSchedule.assertions.find(
    (e) => e.key === 'king-guest-champion',
  );
  assert.equal(a.announcedUntilDate, '2026-11-12');
  assert.equal(a.durationDays, undefined);
  assert.equal(a.endBoundary, 'unspecified');
});
test('initial history, anchor, unknown days and December predictions stay intact', () => {
  const r = review();
  for (const id of ['history', 'dec-dragon', 'dec-king'])
    assert.deepEqual(
      r.candidate.events.find((e) => e.id === id),
      r.calendar.events.find((e) => e.id === id),
    );
  assert.deepEqual(r.coverageState.historyAnchor, r.state.historyAnchor);
  assert.deepEqual(r.coverageState.coveredRanges, r.state.coveredRanges);
  assert.equal(r.report.uncoveredDates.length, 19);
  assert.ok(r.coverageState.officialSchedule.backfillIds.includes('king'));
});
test('all explicit durations preserved in assertions; existing timed Gold gets four days', () => {
  const r = review();
  assert.deepEqual(
    r.coverageState.officialSchedule.assertions.map((e) => e.durationDays ?? null),
    [5, 26, null, 7, 5, 4],
  );
  const e = r.candidate.events.find((e) => e.id === 'gold');
  assert.equal(e.durationDays, 4);
  assert.equal(e.endsAt, '2026-12-01T15:00:00.000Z');
});
test('runtime conversion retains date precision without a midnight timestamp', () => {
  const r = review();
  validate(r.candidate);
  const converted = remoteCalendarDatasetToOccurrences(r.candidate);
  for (const id of ['dragon', 'king']) {
    const e = converted.find((e) => e.id === id);
    assert.equal(e.precision, 'date');
    assert.equal(e.startAt, undefined);
    assert.ok(!e.startDate.includes('T'));
  }
});
test('second official review is byte-idempotent even at a later time', () => {
  const r = review(),
    second = reviewOfficial(
      r.candidate,
      r.coverageState,
      manifest,
      '2026-11-22T00:00:00Z',
      validate,
    );
  assert.equal(serialize(r.candidate), serialize(second.candidate));
  assert.equal(serialize(r.coverageState), serialize(second.coverageState));
});
test('selector suppression ignores changed PDF IDs and hours but does not target December', () => {
  for (const [definitionId, date] of [
    ['dragon-invasion:dragon-invasion', '2026-11-19'],
    ['guest-champion:reinhold', '2026-11-18'],
  ]) {
    assert.ok(
      isOfficialForecast(
        { id: 'different', definitionId, allDay: false, startsAt: date + 'T08:00:00Z' },
        manifest,
      ),
    );
    assert.ok(!isOfficialForecast({ definitionId, allDay: true, date: '2026-12-18' }, manifest));
  }
});
test('historical mutation or official binding tampering is rejected', () => {
  const r = review();
  r.candidate.events.find((e) => e.id === 'history').title = 'Changed';
  assert.throws(
    () => reviewOfficial(r.candidate, r.coverageState, manifest, now, validate),
    /anchor/,
  );
  const r2 = review();
  r2.candidate.events.find((e) => e.id === 'dragon').date = '2026-11-21';
  assert.throws(
    () => reviewOfficial(r2.candidate, r2.coverageState, manifest, now, validate),
    /binding/,
  );
});
test('duplicate official occurrence or unreviewed manifest change fails closed', () => {
  const { calendar, state } = fixture();
  calendar.events.push({ ...calendar.events[1], id: 'duplicate' });
  assert.throws(() => reviewOfficial(calendar, state, manifest, now, validate), /duplicate/);
  const r = review(),
    changed = structuredClone(manifest);
  changed.events[0].durationDays = 6;
  assert.throws(
    () => reviewOfficial(r.candidate, r.coverageState, changed, now, validate),
    /migration/,
  );
});
test('exclusion provenance records both predictions, official source and stable replacement', () => {
  const r = review();
  assert.equal(r.coverageState.officialSchedule.excludedPredictions.length, 2);
  for (const e of r.coverageState.officialSchedule.excludedPredictions) {
    assert.equal(e.prediction.id, e.replacementId);
    assert.equal(e.sourceUrl, manifest.sourceUrl);
    assert.match(e.reason, /official/);
  }
});
test('mechanism is reusable for another month without a November code branch', () => {
  const { calendar, state } = fixture();
  const other = {
    ...manifest,
    events: [
      {
        key: 'another',
        category: 'unknown',
        canonicalName: 'Another Event',
        definitionId: 'unknown:another',
        date: '2026-12-05',
        durationDays: 2,
      },
    ],
    release: 'another',
  };
  const result = reviewOfficial(calendar, state, other, now, validate);
  assert.ok(result.candidate.events.some((e) => e.date === '2026-12-05'));
});

test('identical PDF extractions cannot restore either invalidated forecast', () => {
  const r = review(),
    names = {},
    coveredDates = Array.from({ length: 31 }, (_, i) =>
      new Date(Date.parse('2026-11-18') + i * 86400000).toISOString().slice(0, 10),
    );
  for (let i = 0; i < 8; i++)
    names['daily' + i] = { category: i < 4 ? 'boss' : 'champion', definitionId: 'daily:' + i };
  for (const c of manifest.events)
    names[c.canonicalName] = { category: c.category, definitionId: c.definitionId };
  const daily = coveredDates.flatMap((date) =>
    Array.from({ length: 8 }, (_, i) => ({
      id: `daily:${i}:${date}`,
      canonicalName: 'daily' + i,
      ...names['daily' + i],
      date,
      timeUtc: '00:00',
      confidence: 'confirmed',
    })),
  );
  const predictions = r.calendar.events
    .filter((e) => !e.allDay)
    .map((e) => ({
      id: e.id,
      canonicalName: e.title,
      definitionId: e.definitionId,
      category: e.category,
      date: e.startsAt.slice(0, 10),
      timeUtc: e.startsAt.slice(11, 16),
      confidence: 'confirmed',
    }));
  const extraction = {
    pdfPages: 44,
    referenceNames: Object.keys(names),
    coveredDates,
    coverage: { from: coveredDates[0], to: coveredDates.at(-1) },
    events: [...daily, ...predictions],
    ambiguities: [],
    nonEventMarkers: [],
    statistics: {
      calendarPages: 1,
      acceptedEvents: daily.length + predictions.length,
      imagePlacements: 31 * 18,
      recognizedImagePlacements: 31 * 18,
      duplicateEventsIgnored: 0,
    },
  };
  const policy = { bootstrapAnchor: r.state.historyAnchor };
  const first = analyze(r.candidate, extraction, now, validate, { names }, r.coverageState, policy);
  const second = analyze(
    first.candidate,
    extraction,
    '2026-11-22T00:00:00Z',
    validate,
    { names },
    first.coverageState,
    policy,
  );
  assert.equal(first.report.status, 'valid');
  assert.equal(second.report.status, 'valid');
  assert.equal(serialize(first.candidate), serialize(second.candidate));
  assert.equal(serialize(first.coverageState), serialize(second.coverageState));
  assert.equal(second.report.changed, false);
  for (const [id, date] of [
    ['dragon', '2026-11-20'],
    ['king', '2026-11-09'],
  ])
    assert.equal(second.candidate.events.find((e) => e.id === id).date, date);
});