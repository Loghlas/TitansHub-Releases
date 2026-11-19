import assert from 'node:assert/strict';
import { sha256 } from '../calendar-pdf-candidate.mjs';
import { serialize } from './core.mjs';
import { loadBase } from './network.mjs';
import { verifyReview } from './review.mjs';

const repository = 'Loghlas/TitansHub-Releases';
const shaPattern = /^[a-f0-9]{40}$/;
export function authorizePublication(
  { eventName, mode, confirmed, approvedSha256, repositoryName, ref, automaticVariable },
  policy,
  report,
) {
  if (repositoryName !== repository || ref !== 'refs/heads/main')
    throw Error('Wrong publication repository or branch.');
  if (eventName === 'workflow_dispatch') {
    if (
      policy.manualPublicationEnabled !== true ||
      mode !== 'publish-reviewed' ||
      confirmed !== true ||
      approvedSha256 !== report.candidateSha256 ||
      !/^[a-f0-9]{64}$/.test(approvedSha256 ?? '')
    )
      throw Error('Explicit manual approval and exact candidate SHA-256 are required.');
  } else if (eventName === 'schedule') {
    if (policy.automaticPublicationEnabled !== true || automaticVariable !== 'true')
      throw Error('Both automatic publication gates must be enabled.');
  } else throw Error('Unsupported publication trigger.');
}

// This client cannot update contents individually, releases, workflows or other refs.
export function publicationClient(token, fetcher = fetch) {
  if (!token) throw Error('Missing repository job token.');
  return async (method, path, body = null, optional = false) => {
    let allowed =
      method === 'GET' &&
      (/^\/git\/ref\/heads\/main$/.test(path) ||
        /^\/contents\/calendar(?:-state)?\.json\?ref=[a-f0-9]{40}$/.test(path) ||
        /^\/git\/commits\/[a-f0-9]{40}$/.test(path));
    if (method === 'POST' && path === '/git/trees') {
      allowed =
        shaPattern.test(body?.base_tree ?? '') &&
        Object.keys(body).sort().join(',') === 'base_tree,tree' &&
        Array.isArray(body.tree) &&
        body.tree.length === 2 &&
        body.tree
          .map((e) => e.path)
          .sort()
          .join(',') === 'calendar-state.json,calendar.json' &&
        body.tree.every(
          (e) =>
            e.mode === '100644' &&
            e.type === 'blob' &&
            typeof e.content === 'string' &&
            Object.keys(e).sort().join(',') === 'content,mode,path,type',
        );
    }
    if (method === 'POST' && path === '/git/commits')
      allowed =
        Object.keys(body ?? {})
          .sort()
          .join(',') === 'message,parents,tree' &&
        shaPattern.test(body.tree ?? '') &&
        body.parents?.length === 1 &&
        shaPattern.test(body.parents[0]) &&
        typeof body.message === 'string' &&
        body.message.startsWith('Update Shop Titans calendar (');
    if (method === 'PATCH' && path === '/git/refs/heads/main')
      allowed =
        Object.keys(body ?? {})
          .sort()
          .join(',') === 'force,sha' &&
        body.force === false &&
        shaPattern.test(body.sha ?? '');
    if (!allowed) throw Error('Publication API request outside two-file atomic scope.');
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'TitansHub-calendar-tools/2',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub ${method} refused (${response.status}).`);
    return response.json();
  };
}

export async function publishReview({
  client,
  input,
  settings,
  authorization,
  now = () => new Date().toISOString(),
}) {
  authorizePublication(authorization, settings.publicationPolicy, input.report);
  const check = verifyReview(input, settings);
  const remote = await loadBase(client);
  assert.equal(remote.commit, input.base.commit, 'Remote HEAD changed; rerun simulation.');
  assert.deepEqual(remote.calendar, input.base.calendar, 'Remote base calendar changed.');
  assert.deepEqual(remote.state, input.base.state, 'Remote base ledger changed.');
  if (!check.changed) return { status: 'unchanged', commit: remote.commit, published: false };
  const byId = new Map(remote.calendar.events.map((e) => [e.id, e]));
  for (const correction of input.report.corrections) {
    const revised = correction.revised ?? correction.after;
    const previous = byId.get(correction.previous?.id);
    if (!previous || !revised) throw Error('Unexplained correction.');
    const instant = (e) => Date.parse(e.allDay ? e.date + 'T00:00:00Z' : e.startsAt);
    if (instant(previous) <= Date.parse(now()) || instant(revised) <= Date.parse(now()))
      throw Error('Reviewed correction is now historical; reanalyze.');
  }
  const parent = await client('GET', `/git/commits/${remote.commit}`);
  const tree = await client('POST', '/git/trees', {
    base_tree: parent.tree.sha,
    tree: [
      { path: 'calendar.json', mode: '100644', type: 'blob', content: serialize(input.candidate) },
      {
        path: 'calendar-state.json',
        mode: '100644',
        type: 'blob',
        content: serialize(input.state),
      },
    ],
  });
  const commit = await client('POST', '/git/commits', {
    message: `Update Shop Titans calendar (${input.report.checkedAt.slice(0, 10)})`,
    tree: tree.sha,
    parents: [remote.commit],
  });
  assert.equal(
    (await client('GET', '/git/ref/heads/main')).object.sha,
    remote.commit,
    'Remote HEAD changed before branch update.',
  );
  let patchError = false;
  try {
    await client('PATCH', '/git/refs/heads/main', { sha: commit.sha, force: false });
  } catch {
    patchError = true;
  }
  let after;
  try {
    after = await loadBase(client);
  } catch {
    const e = Error('Publication outcome unknown; inspect remote state before retrying.');
    e.uncertainPublication = true;
    throw e;
  }
  if (
    after.commit !== commit.sha ||
    sha256(serialize(after.calendar)) !== check.candidateSha256 ||
    sha256(serialize(after.state)) !== check.stateSha256
  ) {
    const e = Error(
      patchError && after.commit === remote.commit
        ? 'Branch update refused; calendars were not replaced.'
        : 'Publication outcome unknown or verification mismatch; do not retry blindly.',
    );
    if (!(patchError && after.commit === remote.commit)) e.uncertainPublication = true;
    throw e;
  }
  return {
    status: 'published-and-verified',
    commit: after.commit,
    published: true,
    candidateSha256: check.candidateSha256,
    stateSha256: check.stateSha256,
  };
}
