import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { analyze, historyAnchor, serialize } from './core.mjs';
import { reviewOfficial } from './official.mjs';
import { readReview, verifySourceRun } from './review.mjs';
import { publishReview, publicationClient, authorizePublication } from './publisher.mjs';
import { calendarRemoteDatasetSchema } from '../calendar-schema.mjs';
const manifest = JSON.parse(
  await readFile(new URL('./official-november-2026.json', import.meta.url)),
);
const policy = JSON.parse(await readFile(new URL('./publication-policy.json', import.meta.url)));
const validate = (x) => calendarRemoteDatasetSchema.parse(x);
const baseSha = 'a'.repeat(40),
  commitSha = 'd'.repeat(40),
  checkedAt = '2026-11-19T00:10:00.000Z';
function makeInput(base, extraction, settings) {
  const r = analyze(
    base.calendar,
    extraction,
    checkedAt,
    validate,
    settings.profile,
    base.state,
    settings.mergePolicy,
  );
  r.report.baseCommit = base.commit;
  r.report.publication = 'DISABLED — simulation only';
  return { base, extraction, candidate: r.candidate, state: r.coverageState, report: r.report };
}
function fixture() {
  const history = Array.from({ length: 702 }, (_, i) => ({
    id: 'history-' + i,
    title: 'Historical ' + i,
    category: 'full-moon',
    allDay: true,
    date: '2026-09-26',
  }));
  const predictions = [
    ['dragon', 'Dragon Invasion', 'dragon-invasion', '2026-11-19T15:00:00.000Z'],
    ['king', 'Reinhold', 'guest-champion', '2026-11-18T00:00:00.000Z'],
    ['gold', 'Lost City of Gold', 'lost-city-of-gold', '2026-11-27T15:00:00.000Z'],
  ].map(([id, title, category, startsAt]) => ({
    id,
    title,
    canonicalName: title,
    category,
    definitionId: manifest.events.find((e) => e.canonicalName === title).definitionId,
    allDay: false,
    startsAt,
  }));
  const old = {
    schemaVersion: 1,
    timezone: 'UTC',
    updatedAt: '2026-11-18T00:00:00.000Z',
    coverage: { from: '2026-09-01', to: '2026-12-18' },
    events: [...history, ...predictions],
  };
  const oldState = {
    schemaVersion: 1,
    coveredRanges: [
      { from: '2026-09-01', to: '2026-10-29' },
      { from: '2026-11-18', to: '2026-12-18' },
    ],
    historyAnchor: historyAnchor(old.events, '2026-11-18'),
  };
  const official = reviewOfficial(old, oldState, manifest, checkedAt, validate);
  const names = {};
  for (let i = 0; i < 8; i++)
    names['daily' + i] = { category: i < 4 ? 'boss' : 'champion', definitionId: 'daily:' + i };
  for (const c of manifest.events)
    names[c.canonicalName] = { category: c.category, definitionId: c.definitionId };
  const coveredDates = Array.from({ length: 31 }, (_, i) =>
    new Date(Date.parse('2026-11-18') + i * 86400000).toISOString().slice(0, 10),
  );
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
  const extractedPredictions = predictions.map((e) => ({
    id: e.id,
    canonicalName: e.title,
    category: e.category,
    definitionId: e.definitionId,
    date: e.startsAt.slice(0, 10),
    timeUtc: e.startsAt.slice(11, 16),
    confidence: 'confirmed',
  }));
  const extraction = {
    sourceUrl: 'https://example.com/synthetic',
    sourceSha256: 'synthetic',
    pdfPages: 44,
    referenceNames: Object.keys(names),
    coveredDates,
    coverage: { from: coveredDates[0], to: coveredDates.at(-1) },
    events: [...daily, ...extractedPredictions],
    ambiguities: [],
    nonEventMarkers: [],
    statistics: {
      calendarPages: 1,
      acceptedEvents: daily.length + predictions.length,
      imagePlacements: 558,
      recognizedImagePlacements: 558,
      duplicateEventsIgnored: 0,
    },
  };
  const settings = {
    profile: { names },
    mergePolicy: {
      minimumBossesPerDay: 4,
      minimumChampionsPerDay: 3,
      bootstrapAnchor: oldState.historyAnchor,
    },
    publicationPolicy: structuredClone(policy),
  };
  return {
    settings,
    input: makeInput(
      { commit: baseSha, calendar: official.candidate, state: official.coverageState },
      extraction,
      settings,
    ),
  };
}
function authorization(input) {
  return {
    eventName: 'workflow_dispatch',
    mode: 'publish-reviewed',
    confirmed: true,
    approvedSha256: input.report.candidateSha256,
    repositoryName: 'Loghlas/TitansHub-Releases',
    ref: 'refs/heads/main',
  };
}
function fake(
  input,
  {
    headChanged = false,
    failAt = null,
    lostAck = false,
    failVerification = false,
    race = false,
  } = {},
) {
  let current = {
      commit: headChanged ? 'e'.repeat(40) : baseSha,
      calendar: input.base.calendar,
      state: input.base.state,
    },
    tree,
    refReads = 0;
  const calls = [];
  const client = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === failAt) throw Error('Simulated GitHub error');
    if (path === '/git/ref/heads/main') {
      refReads++;
      if (failVerification && current.commit === commitSha) throw Error('Read failed');
      return { object: { sha: race && refReads === 2 ? 'f'.repeat(40) : current.commit } };
    }
    if (path.startsWith('/contents/'))
      return {
        encoding: 'base64',
        content: Buffer.from(
          serialize(path.includes('calendar-state') ? current.state : current.calendar),
        ).toString('base64'),
      };
    if (method === 'GET' && path.startsWith('/git/commits/'))
      return { tree: { sha: 'b'.repeat(40) } };
    if (path === '/git/trees') {
      tree = body;
      return { sha: 'c'.repeat(40) };
    }
    if (path === '/git/commits') return { sha: commitSha };
    if (path === '/git/refs/heads/main') {
      assert.equal(body.force, false);
      current = {
        commit: commitSha,
        calendar: JSON.parse(tree.tree.find((e) => e.path === 'calendar.json').content),
        state: JSON.parse(tree.tree.find((e) => e.path === 'calendar-state.json').content),
      };
      if (lostAck) throw Error('Lost acknowledgement');
      return {};
    }
    throw Error('Unexpected simulated request');
  };
  return { client, calls, current: () => current };
}
function attempt(options = {}, mutate = () => {}) {
  const f = fixture();
  mutate(f);
  const g = fake(f.input, options);
  return {
    f,
    g,
    run: () =>
      publishReview({
        ...f,
        client: g.client,
        authorization: authorization(f.input),
        now: () => checkedAt,
      }),
  };
}
test('valid additions publish exactly two files in a single commit, without force', async () => {
  const { f, g, run } = attempt();
  const r = await run();
  assert.equal(r.status, 'published-and-verified');
  const writes = g.calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(
    writes.map((c) => c.path),
    ['/git/trees', '/git/commits', '/git/refs/heads/main'],
  );
  assert.deepEqual(
    writes[0].body.tree.map((e) => e.path),
    ['calendar.json', 'calendar-state.json'],
  );
  assert.deepEqual(writes[1].body.parents, [baseSha]);
  assert.equal(g.current().calendar.events.filter((e) => e.id.startsWith('history-')).length, 702);
  assert.deepEqual(g.current().state.officialSchedule, f.input.base.state.officialSchedule);
});
test('repeated simulation is byte-idempotent and unchanged review creates no commit', async () => {
  const f = fixture();
  f.input = makeInput(
    { commit: baseSha, calendar: f.input.candidate, state: f.input.state },
    f.input.extraction,
    f.settings,
  );
  assert.equal(f.input.report.changed, false);
  const g = fake(f.input);
  const result = await publishReview({
    ...f,
    client: g.client,
    authorization: authorization(f.input),
  });
  assert.equal(result.status, 'unchanged');
  assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0);
});
test('changed HEAD stops before any write', async () => {
  const { g, run } = attempt({ headChanged: true });
  await assert.rejects(run, /HEAD changed/);
  assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0);
});
test('concurrent advance before PATCH leaves both public calendars untouched', async () => {
  const { f, g, run } = attempt({ race: true });
  await assert.rejects(run, /HEAD changed/);
  assert.equal(g.calls.filter((c) => c.method === 'PATCH').length, 0);
  assert.deepEqual(g.current().calendar, f.input.base.calendar);
});
for (const [label, mutate] of [
  [
    'schema drift',
    (f) => {
      f.input.candidate.schemaVersion = 2;
    },
  ],
  [
    'duplicate',
    (f) => {
      f.input.candidate.events.push(f.input.candidate.events[0]);
    },
  ],
  [
    'historical removal',
    (f) => {
      f.input.candidate.events = f.input.candidate.events.filter((e) => e.id !== 'history-0');
    },
  ],
  [
    'lost ledger',
    (f) => {
      f.input.state = {};
    },
  ],
  [
    'official date changed',
    (f) => {
      f.input.candidate.events.find((e) => e.id === 'dragon').date = '2026-11-19';
    },
  ],
  [
    'official exclusion lost',
    (f) => {
      f.input.state.officialSchedule.excludedPredictions = [];
    },
  ],
  [
    'unknown image',
    (f) => {
      f.input.extraction.ambiguities.push({ reason: 'unknown-image' });
    },
  ],
  [
    'incomplete PDF',
    (f) => {
      f.input.extraction.pdfPages = 1;
    },
  ],
  [
    'insufficient extraction',
    (f) => {
      f.input.extraction.events = [];
    },
  ],
  [
    'coverage shrink',
    (f) => {
      f.input.state.coveredRanges.pop();
    },
  ],
  [
    'tampered hash',
    (f) => {
      f.input.report.candidateSha256 = '0'.repeat(64);
    },
  ],
  [
    'blocking conflict',
    (f) => {
      f.input.report.blockers.push('official-conflict');
    },
  ],
  [
    'unexplained report',
    (f) => {
      f.input.report.newEvents++;
    },
  ],
])
  test(label + ' is refused without any write', async () => {
    const { g, run } = attempt({}, mutate);
    await assert.rejects(run);
    assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0);
  });
for (const phase of ['/git/trees', '/git/commits', '/git/refs/heads/main'])
  test('GitHub failure at ' + phase + ' cannot publish one file', async () => {
    const { f, g, run } = attempt({ failAt: phase });
    await assert.rejects(run);
    assert.deepEqual(g.current().calendar, f.input.base.calendar);
    assert.deepEqual(g.current().state, f.input.base.state);
  });
test('lost PATCH acknowledgement is read back, never blindly retried', async () => {
  const { g, run } = attempt({ lostAck: true });
  assert.equal((await run()).status, 'published-and-verified');
  assert.equal(g.calls.filter((c) => c.method === 'PATCH').length, 1);
});
test('unavailable post-publication verification is explicitly unknown', async () => {
  const { g, run } = attempt({ failVerification: true });
  await assert.rejects(run, (e) => e.uncertainPublication === true);
  assert.equal(g.calls.filter((c) => c.method === 'PATCH').length, 1);
});
test('partial contents writes, foreign paths and forced refs are refused before network', async () => {
  let calls = 0;
  const client = publicationClient('synthetic-test-token', async () => {
    calls++;
    return new Response('{}');
  });
  for (const [method, path, body] of [
    ['PUT', '/contents/calendar.json', {}],
    [
      'POST',
      '/git/trees',
      {
        base_tree: baseSha,
        tree: [{ path: 'calendar.json', mode: '100644', type: 'blob', content: '{}' }],
      },
    ],
    ['POST', '/releases', {}],
    ['PATCH', '/git/refs/heads/main', { sha: commitSha, force: true }],
    ['PATCH', '/git/refs/heads/other', { sha: commitSha, force: false }],
  ])
    await assert.rejects(() => client(method, path, body), /scope/);
  assert.equal(calls, 0);
});
test('manual approval requires mode, explicit confirmation and exact SHA', () => {
  const { input } = fixture();
  const auth = authorization(input);
  for (const change of [
    { confirmed: false },
    { mode: 'simulate' },
    { approvedSha256: 'bad' },
    { ref: 'refs/heads/other' },
    { repositoryName: 'other/repo' },
  ])
    assert.throws(() => authorizePublication({ ...auth, ...change }, policy, input.report));
  assert.doesNotThrow(() => authorizePublication(auth, policy, input.report));
});
test('automatic activation requires independent versioned flag and repository variable', () => {
  const { input } = fixture();
  const auth = { ...authorization(input), eventName: 'schedule', automaticVariable: 'true' };
  assert.throws(() =>
    authorizePublication(auth, { ...policy, automaticPublicationEnabled: false }, input.report),
  );
  assert.throws(() =>
    authorizePublication(
      { ...auth, automaticVariable: 'false' },
      { ...policy, automaticPublicationEnabled: true },
      input.report,
    ),
  );
  assert.doesNotThrow(() =>
    authorizePublication(auth, { ...policy, automaticPublicationEnabled: true }, input.report),
  );
});
test('review origin must be successful main simulation at exactly the current code', async () => {
  const run = {
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: baseSha,
    path: '.github/workflows/calendar-update.yml',
    head_repository: { full_name: 'Loghlas/TitansHub-Releases' },
    event: 'workflow_dispatch',
  };
  const args = { runId: '123', currentRunId: '456', currentHead: baseSha };
  await verifySourceRun(async () => run, args);
  for (const change of [
    { conclusion: 'failure' },
    { head_sha: commitSha },
    { head_branch: 'other' },
    { path: 'other.yml' },
    { event: 'pull_request' },
  ])
    await assert.rejects(() => verifySourceRun(async () => ({ ...run, ...change }), args));
  await assert.rejects(() => verifySourceRun(async () => run, { ...args, runId: '456' }));
});
test('approval delayed until a corrected instant is historical refuses all writes', async () => {
  const f = fixture();
  const extraction = structuredClone(f.input.extraction);
  extraction.events.find((e) => e.id === 'daily:0:2026-11-20').timeUtc = '01:00';
  f.input = makeInput(
    { commit: baseSha, calendar: f.input.candidate, state: f.input.state },
    extraction,
    f.settings,
  );
  assert.equal(f.input.report.modifiedEvents, 1);
  const g = fake(f.input);
  await assert.rejects(
    () =>
      publishReview({
        ...f,
        client: g.client,
        authorization: authorization(f.input),
        now: () => '2026-11-21T00:00:00Z',
      }),
    /now historical/,
  );
  assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0);
});

test('missing ledger or modified artifact bytes are rejected at loading', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'titanshub-publication-test-'));
  try {
    const { input } = fixture();
    for (const [name, value] of Object.entries({
      'base.json': input.base,
      'extraction.json': input.extraction,
      'report.json': input.report,
      'calendar.candidate.json': input.candidate,
    }))
      await writeFile(join(temporary, name), serialize(value));
    await assert.rejects(() => readReview(temporary));
    await writeFile(join(temporary, 'calendar-state.candidate.json'), serialize(input.state));
    await readReview(temporary);
    await writeFile(join(temporary, 'calendar.candidate.json'), serialize(input.candidate) + ' ');
    await assert.rejects(() => readReview(temporary), /hash mismatch/);
  } finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(temporary.includes('titanshub-publication-test-'));
    await rm(temporary, { recursive: true, force: true });
  }
});
