import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readReview, verifyReview, verifySourceRun } from './review.mjs';
import { githubClient } from './network.mjs';
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'review' },
    origin: { type: 'boolean', default: false },
  },
});
const json = async (n) => JSON.parse(await readFile(new URL(n, import.meta.url), 'utf8'));
if (values.origin) {
  await verifySourceRun(githubClient(process.env.GITHUB_TOKEN), {
    runId: process.env.REVIEW_RUN_ID,
    currentRunId: process.env.GITHUB_RUN_ID,
    currentHead: process.env.GITHUB_SHA,
  });
  if (
    process.env.CONFIRM_PUBLICATION !== 'true' ||
    !/^[a-f0-9]{64}$/.test(process.env.APPROVED_SHA256 ?? '')
  )
    throw Error('Manual publication confirmation and candidate SHA-256 are required.');
  console.log('Reviewed successful simulation origin verified.');
} else {
  const settings = {
    profile: await json('../calendar_pdf/profile.json'),
    mergePolicy: await json('./policy.json'),
    publicationPolicy: await json('./publication-policy.json'),
  };
  const input = await readReview(values.out);
  const result = verifyReview(input, settings);
  if (
    process.env.REVIEW_MODE === 'publish-reviewed' &&
    process.env.APPROVED_SHA256 !== result.candidateSha256
  )
    throw Error('Approved SHA-256 differs from artifact.');
  if (process.env.GITHUB_SHA && input.base.commit !== process.env.GITHUB_SHA)
    throw Error('Analysis base differs from workflow commit.');
  if (process.env.GITHUB_OUTPUT)
    await writeFile(
      process.env.GITHUB_OUTPUT,
      `valid=true\nchanged=${result.changed}\nautomatic_allowed=${settings.publicationPolicy.automaticPublicationEnabled === true}\ncandidate_sha256=${result.candidateSha256}\n`,
      { flag: 'a' },
    );
  console.log(JSON.stringify(result));
}
