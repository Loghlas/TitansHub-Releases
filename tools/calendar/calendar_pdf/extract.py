"""Offline PDF-object extraction. No OCR, downloads, or source-image exports."""
import argparse
from collections import Counter, defaultdict
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
import sys


class ExtractionError(ValueError):
    pass


def center(item, axis):
    keys = ('x0', 'x1') if axis == 'x' else ('top', 'bottom')
    return sum(item[k] for k in keys) / 2


def normalized(text):
    return ' '.join(text.replace('’', "'").split()).casefold()


def text_lines(words):
    lines = []
    for word in sorted(words, key=lambda w: (w['top'], w['x0'])):
        target = next((line for line in lines if abs(line[0]['top'] - word['top']) < .8), None)
        if target is None:
            lines.append([word])
        else:
            target.append(word)
    return [' '.join(w['text'] for w in sorted(line, key=lambda w: w['x0'])) for line in lines]


def image_fingerprint(stream):
    descriptor = str((stream.get('Width'), stream.get('Height'),
                      stream.get('BitsPerComponent'), stream.get('ColorSpace')))
    digest = hashlib.sha256(descriptor.encode() + stream.get_data())
    mask = stream.get('SMask')
    if mask is not None:
        from pdfminer.pdftypes import resolve1
        mask = resolve1(mask)
        if hasattr(mask, 'get_data'):
            digest.update(mask.get_data())
    return digest.hexdigest()


def read_pdf(path):
    import pdfplumber
    path = Path(path)
    if path.read_bytes()[:5] != b'%PDF-':
        raise ExtractionError('Invalid PDF signature.')
    try:
        pages, fingerprints = [], {}
        with pdfplumber.open(path) as pdf:
            if len(pdf.pages) > 200:
                raise ExtractionError('PDF exceeds the 200-page safety limit.')
            for number, page in enumerate(pdf.pages, 1):
                images = []
                for image in page.images:
                    stream = image['stream']
                    if stream.objid not in fingerprints:
                        fingerprints[stream.objid] = image_fingerprint(stream)
                    images.append({k: image[k] for k in ('x0', 'x1', 'top', 'bottom')} |
                                  {'objectRef': stream.objid, 'fingerprint': fingerprints[stream.objid]})
                pages.append({'page': number, 'words': page.extract_words(x_tolerance=1, y_tolerance=2),
                              'images': images, 'rects': [
                                  {k: r[k] for k in ('x0', 'x1', 'top', 'bottom')}
                                  for r in page.rects]})
        return pages
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError(f'Unreadable PDF ({type(error).__name__}).') from error


def calendar_grid(page):
    dates = []
    for word in page['words']:
        if re.fullmatch(r'20\d{2}/\d{2}/\d{2}', word['text']):
            try:
                value = date.fromisoformat(word['text'].replace('/', '-')).isoformat()
            except ValueError:
                raise ExtractionError('Invalid calendar date in PDF.')
            dates.append(word | {'date': value})
    if len(dates) < 7:
        return None
    hours = [w for w in page['words'] if re.fullmatch(r'(?:[01]\d|2[0-3]):00', w['text'])]
    if not hours:
        return None
    if not any('UTC' in w['text'] for w in page['words']):
        raise ExtractionError('Calendar timezone is not explicitly UTC.')
    dates.sort(key=lambda w: w['x0'])
    if len({round(w['top'], 1) for w in dates}) != 1:
        raise ExtractionError('Multiple date rows need a reviewed layout profile.')
    if len({w['date'] for w in dates}) != len(dates):
        raise ExtractionError('Duplicate calendar date columns.')
    for left, right in zip(dates, dates[1:]):
        if date.fromisoformat(right['date']) - date.fromisoformat(left['date']) != timedelta(days=1):
            raise ExtractionError('Calendar columns are not consecutive dates.')
    if {w['text'] for w in hours} != {f'{i:02}:00' for i in range(24)} or len(hours) != 24:
        raise ExtractionError('A complete, unique UTC hour column is required.')
    bands = []
    for hour in hours:
        rectangles = [r for r in page['rects'] if r['x0'] <= center(hour, 'x') <= r['x1']
                      and r['top'] <= center(hour, 'y') <= r['bottom']
                      and r['x1'] < dates[0]['x1']]
        if not rectangles:
            raise ExtractionError('Missing hour-cell geometry; nearest-hour guessing is forbidden.')
        rectangle = min(rectangles, key=lambda r: (r['x1']-r['x0']) * (r['bottom']-r['top']))
        siblings = sorted([w for w in hours if rectangle['top'] < center(w, 'y') < rectangle['bottom']],
                          key=lambda w: w['top'])
        index = siblings.index(hour)
        top = rectangle['top'] if index == 0 else (center(siblings[index-1], 'y') + center(hour, 'y')) / 2
        bottom = rectangle['bottom'] if index == len(siblings)-1 else (center(siblings[index+1], 'y') + center(hour, 'y')) / 2
        bands.append({'timeUtc': hour['text'], 'top': top, 'bottom': bottom})
    centers = [center(w, 'x') for w in dates]
    step = centers[1] - centers[0]
    if any(abs(b-a-step) > step * .05 for a, b in zip(centers, centers[1:])):
        raise ExtractionError('Irregular calendar columns need review.')
    return {'dates': dates, 'step': step, 'bands': bands}


def reference_catalog(pages, profile):
    catalog = defaultdict(list)
    known = {normalized(name): (name, definition) for name, definition in profile['names'].items()}
    for page in pages:
        if calendar_grid(page) is not None or not page['images']:
            continue
        words, headings = page['words'], text_lines(page['words'])
        champion = any('Champions' in line and 'Gear' in line for line in headings)
        if not (champion or 'Bosses' in headings or 'Events' in headings or
                'Content Pass' in headings):
            continue
        min_x = min(i['x0'] for i in page['images'])
        for image in page['images']:
            primary = abs(image['x0']-min_x) < 3
            row = [w for w in words if image['top'] < center(w, 'y') < image['bottom'] and
                   ((w['x1'] < min_x) if champion else (w['x0'] > image['x1']))]
            if champion and not primary:
                entry = {'role': 'champion-request-marker', 'referencePage': page['page']}
            elif primary:
                names = text_lines(row)
                if len(names) != 1:
                    continue
                match = known.get(normalized(names[0]))
                entry = {'role': 'event', 'label': names[0], 'referencePage': page['page']}
                if match:
                    entry |= {'canonicalName': match[0], **match[1]}
                else:
                    entry['category'] = 'unknown'
            else:
                entry = {'role': 'reference-decoration', 'referencePage': page['page']}
            if entry not in catalog[image['fingerprint']]:
                catalog[image['fingerprint']].append(entry)
    return catalog


def extract(pages, profile):
    catalog = reference_catalog(pages, profile)
    ambiguities, events, headers, markers = [], [], [], []
    seen, covered_dates, grids, duplicates = set(), set(), 0, 0
    placements = recognized = 0
    unique_images = set()
    for page in pages:
        grid = calendar_grid(page)
        if grid is None:
            continue
        grids += 1
        if not page['images']:
            raise ExtractionError('Calendar page has no image objects.')
        covered_dates.update(w['date'] for w in grid['dates'])
        first_y = min(b['top'] for b in grid['bands'])
        for image in page['images']:
            placements += 1
            unique_images.add(image['fingerprint'])
            candidates = catalog.get(image['fingerprint'], [])
            identities = {(e.get('role'), e.get('canonicalName', e.get('label'))) for e in candidates}
            observation = {'page': page['page'], 'objectRef': image['objectRef'],
                           'fingerprint': image['fingerprint'],
                           'bbox': [round(image[k], 4) for k in ('x0','top','x1','bottom')],
                           'confidence': 'unresolved'}
            if image['x1'] - image['x0'] > grid['step'] * 1.12:
                ambiguities.append(observation | {'reason': 'image-spans-date-columns'})
                continue
            column = min(grid['dates'], key=lambda w: abs(center(w, 'x') - center(image, 'x')))
            if abs(center(column, 'x')-center(image, 'x')) > grid['step']/2:
                ambiguities.append(observation | {'reason': 'image-outside-date-columns'})
                continue
            observation['date'] = column['date']
            if len(identities) != 1:
                ambiguities.append(observation | {'reason': 'unknown-or-conflicting-image', 'candidates': candidates})
                continue
            entry = candidates[0]
            recognized += 1
            observation |= entry | {'confidence': 'confirmed-identity'}
            if center(image, 'y') < first_y:
                if entry['role'] != 'event':
                    ambiguities.append(observation | {'reason': 'non-event-in-header'})
                    continue
                headers.append(observation)
                if entry.get('category') != 'full-moon':
                    continue  # Header presence is not proof of an event start/duration.
            else:
                bands = [b for b in grid['bands'] if b['top'] < center(image, 'y') < b['bottom']]
                if len(bands) != 1:
                    ambiguities.append(observation | {'reason': 'ambiguous-hour-band'})
                    continue
                observation['timeUtc'] = bands[0]['timeUtc']
                if entry['role'] == 'champion-request-marker':
                    markers.append(observation)
                    continue
                if entry['role'] != 'event':
                    ambiguities.append(observation | {'reason': 'unexpected-decoration-in-calendar'})
                    continue
                if entry.get('category') in profile['boundaryCategories'] and observation['timeUtc'] != profile['startBoundaryUtc']:
                    ambiguities.append(observation | {'reason': 'start-versus-end-marker-unproven'})
                    continue
            if entry.get('category', 'unknown') == 'unknown':
                ambiguities.append(observation | {'reason': 'unmapped-event-type'})
                continue
            key = (entry['definitionId'], observation['date'], observation.get('timeUtc'))
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            event = {**observation, 'id': 'pdf:' + ':'.join(str(x) for x in key if x is not None),
                     'confidence': 'confirmed', 'sourceType': 'community-pdf-objects',
                     'sourceUrl': profile['sourceUrl']}
            if entry['category'] in ('modifier-24-hour', 'modifier-48-hour'):
                event['durationDays'] = 1 if entry['category'] == 'modifier-24-hour' else 2
            events.append(event)
    if not grids:
        raise ExtractionError('No complete calendar grid was found.')
    coverage = sorted(covered_dates)
    return {'extractorVersion': 1, 'sourceUrl': profile['sourceUrl'],
            'pdfPages': len(pages),
            'referenceNames': sorted({e['canonicalName'] for entries in catalog.values()
                                      for e in entries if e.get('canonicalName')}),
            'coverage': {'from': coverage[0], 'to': coverage[-1]}, 'coveredDates': coverage,
            'statistics': {'calendarPages': grids, 'imagePlacements': placements,
                           'recognizedImagePlacements': recognized,
                           'identityRecognitionRate': recognized/placements if placements else 0,
                           'uniqueCalendarImages': len(unique_images), 'acceptedEvents': len(events),
                           'headerObservations': len(headers), 'nonEventRequestMarkers': len(markers),
                           'duplicateEventsIgnored': duplicates, 'ambiguities': len(ambiguities),
                           'eventsByCategory': dict(sorted(Counter(e['category'] for e in events).items()))},
            'events': sorted(events, key=lambda e: (e['date'], e.get('timeUtc', ''), e['definitionId'])),
            'ambiguities': ambiguities, 'headerObservations': headers,
            'nonEventMarkers': markers, 'license': license_evidence(pages)}


def license_evidence(pages):
    text = ' '.join(' '.join(w['text'] for w in p['words']) for p in pages)
    notices = []
    if 'Attribution-NonCommercial-NoDerivatives' in text:
        notices.append('CC BY-NC-ND 4.0')
    if 'CC BY-NC-SA 4.0' in text:
        notices.append('CC BY-NC-SA 4.0')
    return {'notices': notices, 'status': 'conflicting-notices' if len(notices)>1 else 'requires-review',
            'redistributionApproved': False, 'attribution': 'Nerilea Aeliran; Shop Titans Fan Kit assets by Kabam Games, Inc.',
            'reviewRequired': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--profile', default=str(Path(__file__).with_name('profile.json')))
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        result = extract(read_pdf(args.pdf), json.loads(Path(args.profile).read_text(encoding='utf8')))
        result['sourceSha256'] = hashlib.sha256(Path(args.pdf).read_bytes()).hexdigest()
        result['profileSha256'] = hashlib.sha256(Path(args.profile).read_bytes()).hexdigest()
        result['sourceFile'] = Path(args.pdf).name
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n', encoding='utf8')
        print(json.dumps(result['statistics']))
    except (ExtractionError, OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
