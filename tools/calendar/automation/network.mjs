


export const repository = 'Loghlas/TitansHub-Releases';
export const pdfUrl =
  'https://docs.google.com/spreadsheets/d/1T9mvInbrzdzjLstWUv4JjHoTu1rUW49Q6XWvJB9ZMdM/export?format=pdf';
const apiRoot = `https://api.github.com/repos/${repository}`;
const allowedPdfHost = (host) =>
  host === 'docs.google.com' ||
  host.endsWith('.googleusercontent.com') ||
  host === 'doc-0k-00-sheets.googleusercontent.com';

export async function downloadPdf(
  fetcher = fetch,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      try {
        let url = pdfUrl,
          response;
        for (let hop = 0; hop < 6; hop++) {
          if (new URL(url).protocol !== 'https:' || !allowedPdfHost(new URL(url).hostname))
            throw new Error('Unexpected PDF redirect host.');
          response = await fetcher(url, {
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': 'TitansHub-calendar-tools/1' },
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            url = new URL(response.headers.get('location'), url).href;
            await response.body?.cancel();
            continue;
          }
          break;
        }
        if (
          response.status !== 200 ||
          !response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')
        )
          throw new Error('PDF download refused: invalid HTTP status or content type.');
        const pieces = [];
        let total = 0;
        for await (const piece of response.body) {
          total += piece.length;
          if (total > 25_000_000) throw new Error('PDF exceeds size limit.');
          pieces.push(Buffer.from(piece));
        }
        const bytes = Buffer.concat(pieces);
        if (
          bytes.subarray(0, 5).toString() !== '%PDF-' ||
          !bytes.subarray(-2048).includes(Buffer.from('%%EOF'))
        )
          throw new Error('PDF is invalid or truncated.');
        return bytes;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      if (attempt === 1)
        throw new Error('PDF unavailable or invalid after two anonymous attempts.');
      await pause(2_000);
    }
  }
}

export function githubClient(token = null, fetcher = fetch) {
  return async (method, path, body = null, optional = false) => {
    if (method !== 'GET' || body !== null) throw new Error('Simulation client is read-only.');
    const response = await fetcher(`${apiRoot}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'TitansHub-calendar-tools/1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} refused (${response.status}).`);
    return response.json();
  };
}

export async function loadBase(client) {
  const ref = await client('GET', '/git/ref/heads/main');
  const commit = ref.object.sha;
  const read = async (name, optional = false) => {
    const file = await client('GET', `/contents/${name}?ref=${commit}`, null, optional);
    if (!file) return null;
    if (file.encoding !== 'base64') throw new Error('Unexpected GitHub file encoding.');
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  };
  return {
    commit,
    calendar: await read('calendar.json'),
    state: await read('calendar-state.json', true),
  };
}

