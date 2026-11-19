/** Generic reviewed assertions: authoritative dates, scoped forecast exclusions, no inferred hours. */
import { sha256 } from '../calendar-pdf-candidate.mjs';
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const same = (a, b) => serialize(a) === serialize(b);
const dateOf = (event) => (event.allDay ? event.date : event.startsAt).slice(0, 10);
const digest = (event) => sha256(serialize(event));
const validDate = (date) =>
  typeof date === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;

export function validateOfficialManifest(manifest) {
  if (
    manifest?.schemaVersion !== 2 ||
    manifest.precision !== 'date' ||
    manifest.timezone !== null ||
    new URL(manifest.sourceUrl).origin !== 'https://playshoptitans.com' ||
    !manifest.events?.length
  )
    throw new Error('Invalid reviewed official manifest.');
  const keys = new Set(),
    slots = new Set();
  for (const claim of manifest.events) {
    const slot = `${claim.definitionId}:${claim.date}`;
    if (
      !claim.key ||
      !claim.definitionId ||
      !claim.category ||
      !claim.canonicalName ||
      keys.has(claim.key) ||
      slots.has(slot) ||
      !validDate(claim.date) ||
      (claim.durationDays !== undefined &&
        (!Number.isInteger(claim.durationDays) ||
          claim.durationDays < 1 ||
          claim.durationDays > 366)) ||
      (claim.announcedUntilDate !== undefined &&
        (!validDate(claim.announcedUntilDate) || claim.announcedUntilDate < claim.date)) ||
      (claim.timing !== undefined && claim.timing !== 'date-only')
    )
      throw new Error('Invalid or duplicate official assertion.');
    keys.add(claim.key);
    slots.add(slot);
    for (const selector of claim.supersedes ?? []) {
      if (
        selector.definitionId !== claim.definitionId ||
        !validDate(selector.date) ||
        selector.date === claim.date
      )
        throw new Error('Invalid scoped forecast exclusion.');
    }
  }
}

export function isOfficialForecast(event, manifest) {
  return manifest.events.some(
    (claim) =>
      event.definitionId === claim.definitionId &&
      (dateOf(event) === claim.date ||
        (claim.supersedes ?? []).some((s) => dateOf(event) === s.date)),
  );
}

export function applyOfficialAssertions(existing, state, manifest, checkedAt) {
  validateOfficialManifest(manifest);
  if (!state?.historyAnchor || !Number.isFinite(Date.parse(checkedAt)))
    throw new Error('Missing ledger or invalid review time.');
  const previous = state.officialSchedule;
  const manifestSha256 = sha256(serialize(manifest));
  if (
    previous &&
    previous.manifestSha256 !== manifestSha256 &&
    !(previous.schemaVersion === 1 && manifest.supersedesManifestSha256 === previous.manifestSha256)
  )
    throw new Error('Official manifest changed; reviewed migration required.');
  for (const binding of previous?.eventBindings ?? []) {
    const event = existing.events.find((e) => e.id === binding.id);
    if (!event || digest(event) !== binding.sha256) throw new Error('Official binding changed.');
  }
  const candidate = structuredClone(existing),
    added = [],
    corrections = [],
    audit = [];
  const excludedPredictions = structuredClone(previous?.excludedPredictions ?? []);
  const backfillIds = new Set(previous?.backfillIds ?? []);
  for (const claim of manifest.events) {
    const exact = candidate.events.filter(
      (e) => e.definitionId === claim.definitionId && dateOf(e) === claim.date,
    );
    const invalidated = candidate.events.filter((e) =>
      (claim.supersedes ?? []).some(
        (s) => e.definitionId === s.definitionId && dateOf(e) === s.date,
      ),
    );
    if (exact.length + invalidated.length > 1)
      throw new Error('Ambiguous official occurrence; duplicate review required.');
    const old = exact[0] ?? invalidated[0];
    if (old && dateOf(old) < state.historyAnchor.before && !backfillIds.has(old.id)) {
      // Original anchored history is immutable, even for a newly reviewed source.
      if (invalidated.length || claim.timing === 'date-only' || !old.allDay)
        throw new Error('Anchored historical mutation refused.');
    }
    let event;
    if (!old || invalidated.length || claim.timing === 'date-only') {
      event = {
        id: old?.id ?? `official:${claim.key}:${claim.date}`,
        category: claim.category,
        title: claim.canonicalName,
        canonicalName: claim.canonicalName,
        definitionId: claim.definitionId,
        allDay: true,
        date: claim.date,
      };
    } else {
      event = { ...old };
      if (!event.allDay && claim.durationDays !== undefined) {
        event.durationDays = claim.durationDays;
        event.endsAt = new Date(
          Date.parse(event.startsAt) + claim.durationDays * 86400000,
        ).toISOString();
      }
    }
    if (!old) {
      candidate.events.push(event);
      added.push(event.id);
    } else if (!same(old, event)) {
      candidate.events[candidate.events.findIndex((e) => e.id === old.id)] = event;
      corrections.push({
        previous: old,
        revised: event,
        sourceUrl: manifest.sourceUrl,
        reason: 'official-assertion-priority',
      });
    }
    if (
      (!old || dateOf(old) >= state.historyAnchor.before || backfillIds.has(old.id)) &&
      claim.date < state.historyAnchor.before
    )
      backfillIds.add(event.id);
    for (const prediction of invalidated) {
      if (!excludedPredictions.some((entry) => entry.prediction.id === prediction.id))
        excludedPredictions.push({
          prediction,
          replacementId: event.id,
          sourceUrl: manifest.sourceUrl,
          assertionKey: claim.key,
          reason: 'confirmed-official-announcement-over-sheet-forecast',
        });
    }
    audit.push({
      key: claim.key,
      before: old ?? null,
      after: event,
      official: claim,
      status: invalidated.length
        ? 'prediction-replaced-by-official-date'
        : !old
          ? 'added-date-only'
          : same(old, event)
            ? 'unchanged'
            : 'duration-completed',
    });
  }
  if (added.length || corrections.length) {
    candidate.updatedAt = existing.updatedAt > checkedAt ? existing.updatedAt : checkedAt;
    candidate.events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  const runtimeLimits = audit
    .filter(
      (entry) =>
        entry.after.allDay &&
        (entry.official.durationDays !== undefined ||
          entry.official.announcedUntilDate !== undefined),
    )
    .map((entry) => `${entry.key}:date-only-range-not-supported-by-schema-v1`);
  if (manifest.events.some((claim) => claim.category === 'unknown'))
    runtimeLimits.push('generic-category-without-dedicated-icon');
  const coverageState = {
    ...structuredClone(state),
    officialSchedule: {
      schemaVersion: 2,
      sourceUrl: manifest.sourceUrl,
      manifestSha256,
      manifest,
      firstReviewedAt: previous?.firstReviewedAt ?? checkedAt,
      precision: 'date',
      timezone: null,
      coverageSemantics: 'sparse-assertions-only',
      assertions: manifest.events,
      backfillIds: [...backfillIds].sort(),
      eventBindings: audit
        .map((entry) => ({ id: entry.after.id, sha256: digest(entry.after) }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      excludedPredictions,
      conflicts: [],
      runtimeLimits,
      automaticPublication: 'blocked-pending-runtime-review',
    },
  };
  return { candidate, coverageState, audit, added, corrections };
}
