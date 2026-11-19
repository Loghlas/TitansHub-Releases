import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../calendar-pdf-candidate.mjs';
import { calendarRemoteDatasetSchema } from '../calendar-schema.mjs';
import { analyze, serialize, validateIntegrity } from './core.mjs';
import { verifyAnchoredHistory, reviewOfficial } from './official.mjs';

export async function readReview(directory) {
  if (
    await access(join(directory, 'failure.json')).then(
      () => true,
      () => false,
    )
  )
    throw Error('Failed simulation artifact refused.');
  const names = {
    base: 'base.json',
    extraction: 'extraction.json',
    candidate: 'calendar.candidate.json',
    state: 'calendar-state.candidate.json',
    report: 'report.json',
  };
  const result = {};
  for (const [key, name] of Object.entries(names)) {
    const bytes = await readFile(join(directory, name));
    result[key] = JSON.parse(bytes.toString('utf8'));
    if (key === 'candidate' || key === 'state') result[key + 'Bytes'] = bytes;
  }
  assert.equal(
    sha256(result.candidateBytes),
    result.report.candidateSha256,
    'Calendar file hash mismatch.',
  );
  assert.equal(
    sha256(result.stateBytes),
    result.report.coverageStateSha256,
    'Ledger file hash mismatch.',
  );
  return result;
}

export function verifyReview(input, { profile, mergePolicy, publicationPolicy }) {
  const { base, extraction, candidate, state, report } = input;
  const validate = (x) => calendarRemoteDatasetSchema.parse(x);
  assert.match(base.commit, /^[a-f0-9]{40}$/, 'Missing analyzed base commit.');
  assert.equal(base.commit, report.baseCommit, 'Report base mismatch.');
  if (
    publicationPolicy.schemaVersion !== 1 ||
    publicationPolicy.reviewedDateOnlyRuntimeVersion !== '1.10.3'
  )
    throw Error('Unreviewed runtime contract.');
  if (
    report.status !== 'valid' ||
    report.blockers.length ||
    report.conflicts.length ||
    report.unresolved.length
  )
    throw Error('Invalid or incomplete simulation.');
  validateIntegrity(base.calendar, validate);
  validateIntegrity(candidate, validate);
  assert.ok(base.state?.officialSchedule, 'Official ledger missing.');
  assert.deepEqual(
    base.state.historyAnchor,
    mergePolicy.bootstrapAnchor,
    '702-event anchor changed.',
  );
  assert.deepEqual(state.historyAnchor, base.state.historyAnchor, 'Historical anchor changed.');
  verifyAnchoredHistory(base.calendar.events, base.state);
  verifyAnchoredHistory(candidate.events, state);
  assert.deepEqual(
    state.officialSchedule,
    base.state.officialSchedule,
    'Official assertions or exclusions changed.',
  );
  const official = reviewOfficial(
    base.calendar,
    base.state,
    base.state.officialSchedule.manifest,
    report.checkedAt,
    validate,
  );
  assert.equal(
    serialize(official.candidate),
    serialize(base.calendar),
    'Base official dates are inconsistent.',
  );
  assert.equal(
    serialize(official.coverageState),
    serialize(base.state),
    'Base official ledger is inconsistent.',
  );
  const rebuilt = analyze(
    base.calendar,
    extraction,
    report.checkedAt,
    validate,
    profile,
    base.state,
    mergePolicy,
  );
  for (const [key, value] of Object.entries(rebuilt.report))
    if (key !== 'publication')
      assert.deepEqual(report[key], value, 'Unexplained report difference: ' + key);
  assert.equal(
    serialize(rebuilt.candidate),
    serialize(candidate),
    'Calendar cannot be reproduced.',
  );
  assert.equal(serialize(rebuilt.coverageState), serialize(state), 'Ledger cannot be reproduced.');
  assert.equal(
    sha256(serialize(candidate)),
    report.candidateSha256,
    'Calendar candidate hash mismatch.',
  );
  assert.equal(
    sha256(serialize(state)),
    report.coverageStateSha256,
    'Ledger candidate hash mismatch.',
  );
  for (const old of base.calendar.events)
    assert.ok(
      candidate.events.some((e) => e.id === old.id),
      'Existing event removed.',
    );
  const meaningful = report.newEvents + report.modifiedEvents > 0;
  if (report.changed && !meaningful)
    throw Error('No new exploitable event data; publication refused.');
  return {
    valid: true,
    changed: report.changed,
    meaningful,
    candidateSha256: report.candidateSha256,
    stateSha256: report.coverageStateSha256,
  };
}

export async function verifySourceRun(client, { runId, currentRunId, currentHead }) {
  assert.match(String(runId), /^[1-9][0-9]*$/, 'Invalid review run ID.');
  assert.notEqual(String(runId), String(currentRunId), 'Cannot review the current run.');
  const run = await client('GET', `/actions/runs/${runId}`);
  if (
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.head_branch !== 'main' ||
    run.head_sha !== currentHead ||
    run.path !== '.github/workflows/calendar-update.yml' ||
    run.head_repository?.full_name !== 'Loghlas/TitansHub-Releases' ||
    !['workflow_dispatch', 'schedule'].includes(run.event)
  )
    throw Error('Review run origin, code or success mismatch.');
  return run;
}
