import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readReview } from './review.mjs';
import { publishReview, publicationClient } from './publisher.mjs';
const { values } = parseArgs({ options: { out: { type: 'string', default: 'review' } } });
const json = async (n) => JSON.parse(await readFile(new URL(n, import.meta.url), 'utf8'));
await mkdir(values.out, { recursive: true });
try {
  const settings = {
    profile: await json('../calendar_pdf/profile.json'),
    mergePolicy: await json('./policy.json'),
    publicationPolicy: await json('./publication-policy.json'),
  };
  const input = await readReview(values.out);
  const authorization = {
    eventName: process.env.GITHUB_EVENT_NAME,
    mode: process.env.REVIEW_MODE,
    confirmed: process.env.CONFIRM_PUBLICATION === 'true',
    approvedSha256: process.env.APPROVED_SHA256,
    repositoryName: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    automaticVariable: process.env.CALENDAR_AUTO_PUBLISH,
  };
  const result = await publishReview({
    client: publicationClient(process.env.GITHUB_TOKEN),
    input,
    settings,
    authorization,
  });
  await writeFile(join(values.out, 'publication.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\nPublication: **${result.status}**\nCommit: ${result.commit}\n`,
      { flag: 'a' },
    );
  console.log(JSON.stringify(result));
} catch (error) {
  const result = {
    status: error.uncertainPublication ? 'unknown' : 'refused',
    message: error.message,
  };
  await writeFile(join(values.out, 'publication.json'), JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\nPublication: **${result.status}** — ${result.message}\n`,
      { flag: 'a' },
    );
  console.error(result.message);
  process.exitCode = 1;
}
