import { sha256, toRemoteEvent } from '../calendar-pdf-candidate.mjs';
import { applyOfficialAssertions, isOfficialForecast } from './official-assertions.mjs';

const dayMs = 86_400_000;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const dateOf = (e) => (e.allDay ? e.date : e.startsAt).slice(0, 10);
const start = (e) => (e.allDay ? e.date : new Date(e.startsAt).toISOString());
const identity = (e) =>
  e.definitionId ?? `${e.category}:${(e.canonicalName ?? e.title).toLowerCase()}`;
const key = (e) => `${identity(e)}:${start(e)}`;
const slot = (e) => `${identity(e)}:${dateOf(e)}`;
const future = (e, now) =>
  Date.parse(e.allDay ? `${e.date}T00:00:00Z` : e.startsAt) > Date.parse(now);
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
export function historyAnchor(events, before) {
  const history = events.filter((e) => dateOf(e) < before).sort((a, b) => compare(a.id, b.id));
  return { before, count: history.length, sha256: sha256(JSON.stringify(stable(history))) };
}

export function rangesFromDates(dates) {
  const sorted = [...new Set(dates)].sort();
  const ranges = [];
  for (const date of sorted) {
    const previous = ranges.at(-1);
    if (previous && Date.parse(date) - Date.parse(previous.to) === dayMs) previous.to = date;
    else ranges.push({ from: date, to: date });
  }
  return ranges;
}

export function mergeRanges(ranges) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => compare(a.from, b.from))) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(range.from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(range.to) ||
      Number.isNaN(Date.parse(range.from)) ||
      Number.isNaN(Date.parse(range.to)) ||
      range.from > range.to
    )
      throw new Error('Invalid coverage state.');
    const previous = result.at(-1);
    if (previous && Date.parse(range.from) <= Date.parse(previous.to) + dayMs)
      previous.to = previous.to > range.to ? previous.to : range.to;
    else result.push({ ...range });
  }
  return result;
}

export function uncoveredDates(ranges) {
  const missing = [];
  for (let i = 1; i < ranges.length; i++) {
    for (let t = Date.parse(ranges[i - 1].to) + dayMs; t < Date.parse(ranges[i].from); t += dayMs) {
      if (missing.length > 3660) throw new Error('Excessive coverage gap.');
      missing.push(new Date(t).toISOString().slice(0, 10));
    }
  }
  return missing;
}

export function validateIntegrity(dataset, validate) {
  validate(dataset);
  const ids = new Set(),
    natural = new Set();
  for (const event of dataset.events) {
    const value = key(event);
    if (ids.has(event.id) || natural.has(value)) throw new Error('Unresolved duplicate events.');
    ids.add(event.id);
    natural.add(value);
    for (const timestamp of [
      event.allDay ? `${event.date}T00:00:00Z` : event.startsAt,
      event.endsAt,
    ].filter(Boolean)) {
      if (new Date(timestamp).toISOString().slice(0, 10) !== timestamp.slice(0, 10))
        throw new Error('Invalid calendar date.');
    }
    if (
      !event.allDay &&
      event.durationDays !== undefined &&
      event.endsAt !== undefined &&
      Math.abs(Date.parse(event.endsAt) - Date.parse(event.startsAt) - event.durationDays * dayMs) >
        1
    )
      throw new Error('Inconsistent event duration.');
  }
}

export function analyze(
  existing,
  extraction,
  checkedAt,
  validate,
  profile,
  state = null,
  policy = null,
  officialManifest = null,
) {
  officialManifest ??= state?.officialSchedule?.manifest ?? null;
  if (state?.officialSchedule && !officialManifest)
    throw new Error('Official schedule requires a reviewed assertion manifest migration.');
  validateIntegrity(existing, validate);
  const originalExisting = existing;
  const verifyAnchor = (dataset, ledger) => {
    const backfills = new Set(ledger?.officialSchedule?.backfillIds ?? []);
    return historyAnchor(
      dataset.events.filter((e) => !backfills.has(e.id)),
      ledger.historyAnchor.before,
    );
  };
  if (
    officialManifest &&
    serialize(verifyAnchor(existing, state)) !== serialize(state.historyAnchor)
  )
    throw new Error('Historical anchor mismatch before official merge.');
  const official = officialManifest
    ? applyOfficialAssertions(existing, state, officialManifest, checkedAt)
    : null;
  if (official) {
    existing = official.candidate;
    state = official.coverageState;
  }
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid check time.');
  const blockers = [],
    warnings = [];
  const anchor = state?.historyAnchor ?? policy?.bootstrapAnchor;
  if (
    policy &&
    (!anchor ||
      serialize(
        state?.officialSchedule
          ? verifyAnchor(existing, state)
          : historyAnchor(existing.events, anchor.before),
      ) !== serialize(anchor))
  )
    blockers.push('historical-anchor-mismatch');
  const dates = extraction.coveredDates ?? [];
  const stats = extraction.statistics ?? {};
  const requiredNames = new Set(Object.keys(profile.names));
  const references = new Set(extraction.referenceNames ?? []);
  if ([...requiredNames].some((name) => !references.has(name)) || extraction.pdfPages < 6)
    blockers.push('incomplete-reference-pages');
  if (
    dates.length < 28 ||
    dates.length > 35 ||
    stats.calendarPages !== 1 ||
    extraction.coverage?.from !== dates[0] ||
    extraction.coverage?.to !== dates.at(-1) ||
    rangesFromDates(dates).length !== 1
  )
    blockers.push('unexpected-date-layout');
  if (
    !extraction.events?.length ||
    extraction.events.length < dates.length * 8 ||
    extraction.events.length > dates.length * 18 ||
    stats.acceptedEvents !== extraction.events.length ||
    stats.imagePlacements < dates.length * 15 ||
    stats.imagePlacements > dates.length * 28
  )
    blockers.push('major-event-count-anomaly');
  if (
    stats.recognizedImagePlacements !== stats.imagePlacements ||
    stats.duplicateEventsIgnored !== 0
  )
    blockers.push('image-extraction-or-duplicate-anomaly');
  for (const day of dates) {
    const events = extraction.events.filter((e) => e.date === day);
    if (
      events.filter((e) => e.category === 'boss').length < (policy?.minimumBossesPerDay ?? 0) ||
      events.filter((e) => e.category === 'champion').length < (policy?.minimumChampionsPerDay ?? 0)
    )
      blockers.push('incomplete-daily-event-grid');
  }
  const allowedExclusions = [],
    unresolved = [];
  for (const item of extraction.ambiguities ?? []) {
    if (
      item.reason === 'start-versus-end-marker-unproven' &&
      item.timeUtc === '14:00' &&
      profile.boundaryCategories.includes(item.category) &&
      profile.names[item.canonicalName]?.definitionId === item.definitionId
    )
      allowedExclusions.push(item);
    else unresolved.push(item);
  }
  if (allowedExclusions.length > dates.length * 2 || unresolved.length)
    blockers.push('unexpected-source-observations');
  if (allowedExclusions.length) warnings.push('known-14h-markers-excluded');
  if (extraction.license?.reviewRequired)
    warnings.push('community-license-notices-require-initial-review');
  if (state && (state.schemaVersion !== 1 || !Array.isArray(state.coveredRanges)))
    throw new Error('Invalid coverage state.');
  const oldRanges = mergeRanges(state?.coveredRanges ?? [existing.coverage]);
  if (
    oldRanges[0]?.from !== existing.coverage.from ||
    oldRanges.at(-1)?.to !== existing.coverage.to
  )
    throw new Error('Coverage state does not match the published calendar.');
  const ranges = mergeRanges([...oldRanges, ...rangesFromDates(dates)]);
  let coverageState = { ...(state ?? {}), schemaVersion: 1, coveredRanges: ranges };
  const gaps = uncoveredDates(ranges);
  if (gaps.length) warnings.push('uncovered-dates-reported-without-invented-events');
  const candidateEvents = existing.events.map((e) => ({ ...e }));
  const originals = new Map(existing.events.map((e) => [key(e), e]));
  const existingSlots = new Map();
  for (const event of existing.events)
    existingSlots.set(slot(event), [...(existingSlots.get(slot(event)) ?? []), event]);
  const rawIncoming = extraction.events.map(toRemoteEvent);
  const suppressedOfficialPredictions = officialManifest
    ? rawIncoming.filter((event) => isOfficialForecast(event, officialManifest))
    : [];
  const incoming = rawIncoming.filter((event) => !suppressedOfficialPredictions.includes(event));
  if (
    extraction.events.some(
      (e) =>
        profile.names[e.canonicalName]?.definitionId !== e.definitionId ||
        profile.names[e.canonicalName]?.category !== e.category,
    )
  )
    blockers.push('unrecognized-event-definition');
  const incomingSlots = new Map();
  for (const event of incoming)
    incomingSlots.set(slot(event), [...(incomingSlots.get(slot(event)) ?? []), event]);
  const matched = new Set(
      state?.officialSchedule?.eventBindings.map((binding) => binding.id) ?? [],
    ),
    seen = new Set(),
    added = [],
    modified = [],
    conflicts = [];
  for (const event of incoming) {
    if (!dates.includes(dateOf(event))) {
      blockers.push('event-outside-source-dates');
      continue;
    }
    if (seen.has(key(event))) {
      blockers.push('duplicate-incoming-event');
      continue;
    }
    seen.add(key(event));
    const exact = originals.get(key(event));
    const sameSlot = existingSlots.get(slot(event)) ?? [];
    const previous =
      exact ??
      (sameSlot.length === 1 && incomingSlots.get(slot(event)).length === 1 ? sameSlot[0] : null);
    if (previous) {
      matched.add(previous.id);
      if (
        !event.allDay &&
        start(previous) !== start(event) &&
        previous.endsAt !== undefined &&
        event.endsAt === undefined &&
        event.durationDays === undefined
      ) {
        conflicts.push({ previous, incoming: event });
        blockers.push('future-end-boundary-not-proven');
        continue;
      }
      const revised = {
        ...previous,
        ...(!event.allDay ? { startsAt: event.startsAt } : { date: event.date }),
        ...(event.endsAt === undefined ? {} : { endsAt: event.endsAt }),
        ...(event.durationDays === undefined ? {} : { durationDays: event.durationDays }),
      };
      if (serialize(revised) !== serialize(previous)) {
        if (future(previous, checkedAt) && future(revised, checkedAt)) {
          candidateEvents[candidateEvents.findIndex((e) => e.id === previous.id)] = revised;
          modified.push({ previous, revised });
        } else {
          conflicts.push({ previous, incoming: event });
          blockers.push('attempted-historical-correction');
        }
      }
    } else if (sameSlot.length) {
      conflicts.push({ incoming: event, previous: sameSlot });
      blockers.push('ambiguous-future-correction');
    } else {
      added.push(event);
      candidateEvents.push(event);
    }
  }
  const missingFuture = existing.events.filter(
    (e) => dates.includes(dateOf(e)) && future(e, checkedAt) && !matched.has(e.id),
  );
  if (missingFuture.length) blockers.push('previous-future-events-missing-from-source');
  const semanticChanged =
    added.length > 0 ||
    modified.length > 0 ||
    existing.coverage.from !== ranges[0].from ||
    existing.coverage.to !== ranges.at(-1).to;
  const candidate = semanticChanged
    ? {
        ...existing,
        updatedAt: existing.updatedAt > checkedAt ? existing.updatedAt : checkedAt,
        coverage: { from: ranges[0].from, to: ranges.at(-1).to },
        events: candidateEvents.sort((a, b) => compare(a.id, b.id)),
      }
    : structuredClone(existing);
  validateIntegrity(candidate, validate);
  if (existing.events.some((old) => !candidate.events.some((e) => e.id === old.id)))
    blockers.push('historical-event-loss');
  const rangesChanged = serialize(ranges) !== serialize(oldRanges);
  if (policy)
    coverageState = {
      ...coverageState,
      historyAnchor: state?.officialSchedule
        ? anchor
        : semanticChanged || rangesChanged || !anchor
          ? historyAnchor(candidate.events, checkedAt.slice(0, 10))
          : anchor,
    };
  if (officialManifest && serialize(verifyAnchor(candidate, coverageState)) !== serialize(anchor))
    throw new Error('Historical anchor mismatch after official merge.');
  const stateChanged = serialize(coverageState) !== serialize(state ?? coverageState);
  const report = {
    schemaVersion: 2,
    checkedAt,
    sourceUrl: extraction.sourceUrl,
    sourceSha256: extraction.sourceSha256,
    status: blockers.length ? 'refused' : 'valid',
    changed:
      semanticChanged || stateChanged || !!(official?.added.length || official?.corrections.length),
    recognizedEvents: rawIncoming.length,
    mergedSourceEvents: incoming.length,
    newEvents: added.length + (official?.added.length ?? 0),
    modifiedEvents: modified.length + (official?.corrections.length ?? 0),
    unchangedEvents:
      originalExisting.events.length - modified.length - (official?.corrections.length ?? 0),
    retainedEvents: originalExisting.events.length,
    deletedEvents: 0,
    candidateEvents: candidate.events.length,
    excludedEvents: allowedExclusions.length,
    nonEventMarkers: extraction.nonEventMarkers.length,
    analyzedCoverage: extraction.coverage,
    historicalCoverage: existing.coverage,
    coverage: candidate.coverage,
    uncoveredDates: gaps,
    warnings,
    blockers: [...new Set(blockers)],
    corrections: [...(official?.corrections ?? []), ...modified],
    officialSource: officialManifest?.sourceUrl ?? null,
    officialManifest,
    officialSuppressedPredictions: suppressedOfficialPredictions,
    officialRuntimeLimits: state?.officialSchedule?.runtimeLimits ?? [],
    conflicts,
    missingFuture,
    excluded: allowedExclusions,
    unresolved,
    statistics: stats,
    sourceReuse: extraction.license,
    candidateSha256: sha256(serialize(candidate)),
    coverageStateSha256: sha256(serialize(coverageState)),
    publication: 'simulation; initial explicit approval required',
  };
  return { candidate, coverageState, report };
}
