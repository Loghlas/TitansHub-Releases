/** Offline official-source review using the same assertion layer as the PDF merger. */
import { sha256 } from '../calendar-pdf-candidate.mjs';
import {
  historyAnchor,
  mergeRanges,
  serialize,
  uncoveredDates,
  validateIntegrity,
} from './core.mjs';
import { applyOfficialAssertions } from './official-assertions.mjs';

export function verifyAnchoredHistory(events, state) {
  const exempt = new Set(state?.officialSchedule?.backfillIds ?? []);
  const actual = historyAnchor(
    events.filter((e) => !exempt.has(e.id)),
    state.historyAnchor.before,
  );
  if (serialize(actual) !== serialize(state.historyAnchor))
    throw new Error('Historical anchor mismatch.');
}

export function reviewOfficial(existing, state, manifest, checkedAt, validate) {
  validateIntegrity(existing, validate);
  const ranges = mergeRanges(state.coveredRanges);
  if (ranges[0]?.from !== existing.coverage.from || ranges.at(-1)?.to !== existing.coverage.to)
    throw new Error('Coverage ledger does not match calendar.');
  verifyAnchoredHistory(existing.events, state);
  const result = applyOfficialAssertions(existing, state, manifest, checkedAt);
  validateIntegrity(result.candidate, validate);
  verifyAnchoredHistory(result.candidate.events, result.coverageState);
  for (const event of existing.events)
    if (!result.candidate.events.some((e) => e.id === event.id)) throw new Error('Event removed.');
  const report = {
    schemaVersion: 2,
    checkedAt,
    status: 'review-required',
    automaticPublication: false,
    sourceUrl: manifest.sourceUrl,
    manifestSha256: result.coverageState.officialSchedule.manifestSha256,
    beforeEvents: existing.events.length,
    candidateEvents: result.candidate.events.length,
    addedEvents: result.added,
    corrections: result.corrections,
    deletedEvents: 0,
    audit: result.audit,
    blockers: [],
    conflictsResolved: result.coverageState.officialSchedule.excludedPredictions,
    runtimeLimits: result.coverageState.officialSchedule.runtimeLimits,
    historicalAnchor: state.historyAnchor,
    historicalEventsPreserved: state.historyAnchor.count,
    uncoveredDates: uncoveredDates(state.coveredRanges),
    timezone: {
      official: 'not specified',
      json: 'UTC',
      newHoursInferred: false,
      resolution: 'Official dates retained with date precision; predictive instants removed.',
    },
    candidateSha256: sha256(serialize(result.candidate)),
    coverageStateSha256: sha256(serialize(result.coverageState)),
    publication:
      'local review only; date-only ranges remain in the ledger; no automatic publication',
  };
  return { candidate: result.candidate, coverageState: result.coverageState, report };
}
