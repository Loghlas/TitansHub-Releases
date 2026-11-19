/** Add-only, review-only candidate assembly. This module has no network/publish code. */
import { createHash } from 'node:crypto';

const dayMs = 86_400_000;
const normalize = (value) => value.replaceAll('’', "'").toLowerCase().replace(/\s+/g, ' ').trim();
const start = (event) => (event.allDay ? event.date : new Date(event.startsAt).toISOString());
const identity = (event) => `${event.category}:${normalize(event.canonicalName ?? event.title)}`;
const key = (event) => `${identity(event)}:${start(event)}`;
const dateOf = (event) => start(event).slice(0, 10);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function toRemoteEvent(event) {
  if (event.confidence !== 'confirmed' || !event.definitionId || event.category === 'unknown') {
    throw new Error('An unresolved event cannot enter the candidate.');
  }
  const common = {
    id: event.id,
    category: event.category,
    title: event.canonicalName,
    canonicalName: event.canonicalName,
    definitionId: event.definitionId,
  };
  if (!event.timeUtc) return { ...common, allDay: true, date: event.date };
  if (!/^\d{2}:\d{2}$/.test(event.timeUtc)) throw new Error('Invalid UTC hour.');
  const startsAt = `${event.date}T${event.timeUtc}:00.000Z`;
  return {
    ...common,
    allDay: false,
    startsAt,
    ...(event.durationDays === undefined
      ? {}
      : {
          durationDays: event.durationDays,
          endsAt: new Date(Date.parse(startsAt) + event.durationDays * dayMs).toISOString(),
        }),
  };
}

export function coverageGaps(existingCoverage, coveredDates) {
  if (!coveredDates.length) throw new Error('Empty PDF coverage.');
  const dates = [...coveredDates].sort();
  const from = existingCoverage.from < dates[0] ? existingCoverage.from : dates[0];
  const to = existingCoverage.to > dates.at(-1) ? existingCoverage.to : dates.at(-1);
  if ((Date.parse(to) - Date.parse(from)) / dayMs > 3660)
    throw new Error('Excessive coverage span.');
  const observed = new Set(dates);
  const missing = [];
  for (let time = Date.parse(from); time <= Date.parse(to); time += dayMs) {
    const value = new Date(time).toISOString().slice(0, 10);
    if (!(existingCoverage.from <= value && value <= existingCoverage.to) && !observed.has(value)) {
      missing.push(value);
    }
  }
  return missing;
}

export function buildCandidate(existing, extraction, updatedAt, validate) {
  validate(existing);
  if (extraction.extractorVersion !== 1 || !extraction.events.length)
    throw new Error('Invalid extraction.');
  const original = new Map(existing.events.map((event) => [key(event), event]));
  const candidateEvents = [...existing.events];
  const matched = new Set();
  const added = [],
    modified = [],
    duplicateObservations = [];
  const seen = new Set();
  for (const observation of extraction.events) {
    const incoming = toRemoteEvent(observation);
    const naturalKey = key(incoming);
    if (seen.has(naturalKey)) {
      duplicateObservations.push(incoming.id);
      continue;
    }
    seen.add(naturalKey);
    const previous = original.get(naturalKey);
    if (previous) {
      matched.add(previous.id);
      // Missing duration in the PDF is not permission to erase an existing one.
      const differs = ['endsAt', 'durationDays'].some(
        (field) =>
          incoming[field] !== undefined &&
          previous[field] !== undefined &&
          incoming[field] !== previous[field],
      );
      if (differs)
        modified.push({ previous, incoming, action: 'held-for-review; original-preserved' });
      continue;
    }
    const sameDay = existing.events.filter(
      (event) => identity(event) === identity(incoming) && dateOf(event) === dateOf(incoming),
    );
    if (sameDay.length) {
      modified.push({ previous: sameDay, incoming, action: 'held-for-review; original-preserved' });
      continue;
    }
    if (candidateEvents.some((event) => event.id === incoming.id))
      throw new Error('Conflicting event ID.');
    added.push(incoming);
    candidateEvents.push(incoming);
  }
  const suspiciousDeletions = existing.events.filter(
    (event) =>
      extraction.coverage.from <= dateOf(event) &&
      dateOf(event) <= extraction.coverage.to &&
      !matched.has(event.id),
  );
  const gaps = coverageGaps(existing.coverage, extraction.coveredDates);
  const candidate = {
    schemaVersion: existing.schemaVersion,
    updatedAt: existing.updatedAt > updatedAt ? existing.updatedAt : updatedAt,
    timezone: 'UTC',
    coverage: {
      from:
        existing.coverage.from < extraction.coverage.from
          ? existing.coverage.from
          : extraction.coverage.from,
      to:
        existing.coverage.to > extraction.coverage.to
          ? existing.coverage.to
          : extraction.coverage.to,
    },
    events: candidateEvents.sort((a, b) => a.id.localeCompare(b.id)),
  };
  validate(candidate);
  const blockers = [];
  if (extraction.ambiguities.length) blockers.push('ambiguous-pdf-observations');
  if (gaps.length) blockers.push('uncovered-dates-inside-coverage-envelope');
  if (modified.length) blockers.push('conflicting-events');
  if (suspiciousDeletions.length) blockers.push('existing-events-not-observed-in-new-window');
  if (!extraction.license?.redistributionApproved) blockers.push('source-reuse-not-cleared');
  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  const modifiedOriginalIds = new Set(
    modified.flatMap(({ previous }) =>
      (Array.isArray(previous) ? previous : [previous]).map((event) => event.id),
    ),
  );
  return {
    candidate,
    report: {
      schemaVersion: 1,
      reviewOnly: true,
      sourceSha256: extraction.sourceSha256,
      sourceUrl: extraction.sourceUrl,
      profileSha256: extraction.profileSha256,
      baseDatasetSha256: sha256(JSON.stringify(existing)),
      candidateSha256: sha256(serialized),
      comparison: {
        existingEvents: existing.events.length,
        retainedEvents: existing.events.length,
        newEvents: added.length,
        unchangedEvents: existing.events.length - modifiedOriginalIds.size,
        matchingObservations: matched.size,
        modifiedEvents: modified.length,
        deletedEvents: 0,
        added,
        modified,
        suspiciousDeletions,
        duplicateObservations,
      },
      coverage: {
        existing: existing.coverage,
        pdf: extraction.coverage,
        candidateEnvelope: candidate.coverage,
        uncoveredDates: gaps,
        note: 'Schema v1 has one coverage envelope; gaps are NOT evidence of an empty schedule. Publication is blocked.',
      },
      extractionStatistics: extraction.statistics,
      ambiguities: extraction.ambiguities,
      sourceReuse: extraction.license,
      publication: {
        allowed: false,
        blockers: [...blockers, 'manual-validation-required'],
        note: 'This tool only generates local review files. It never publishes.',
      },
    },
  };
}

export function assertPublishable(report) {
  if (!report.publication.allowed || report.publication.blockers.length) {
    throw new Error(`Publication blocked: ${report.publication.blockers.join(', ')}`);
  }
}
