"""Synthetic object fixtures only: no community images/PDF are redistributed."""
from copy import deepcopy
from datetime import date, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from extract import ExtractionError, calendar_grid, extract, read_pdf


PROFILE = json.loads(Path(__file__).with_name('profile.json').read_text())


def word(text, x, top, width=18, height=2):
    return {'text': text, 'x0': x, 'x1': x+width, 'top': top, 'bottom': top+height}


def image(fingerprint, x, top, height=4, width=8):
    return {'fingerprint': fingerprint, 'objectRef': 1, 'x0': x, 'x1': x+width,
            'top': top, 'bottom': top+height}


def fixtures():
    words = [word('(UTC)', 3, 2)]
    words += [word((date(2026, 11, 28)+timedelta(days=i)).strftime('%Y/%m/%d'),
                   100+i*20, 12) for i in range(7)]
    rects = []
    for hour in range(24):
        top = 30 if hour == 0 else 70+(hour-1)*10
        bottom = 70 if hour == 0 else top+10
        words.append(word(f'{hour:02}:00', 3, (top+bottom)/2-1))
        rects.append({'x0': 0, 'x1': 30, 'top': top, 'bottom': bottom})
    grid = {'page': 1, 'words': words, 'rects': rects,
            'images': [image('chief', 106, 32), image('yeti', 106, 58)]}
    legend = {'page': 2, 'rects': [], 'words': [word('Bosses', 80, 1),
              word('Troublin Chief', 80, 25), word('Yeti King', 80, 55)],
              'images': [image('chief', 10, 20, 20), image('yeti', 10, 50, 20)]}
    return [grid, legend]


class ExtractorTests(unittest.TestCase):
    def test_exact_reference_identity_and_multiple_images_in_large_midnight_cell(self):
        result = extract(fixtures(), PROFILE)
        self.assertEqual(result['statistics']['identityRecognitionRate'], 1)
        self.assertEqual({e['canonicalName'] for e in result['events']}, {'Troublin Chief', 'Yeti King'})
        self.assertEqual({e['timeUtc'] for e in result['events']}, {'00:00'})
        self.assertEqual(result['statistics']['acceptedEvents'], 2)

    def test_month_boundary_and_recurrences_are_only_observed_dates(self):
        pages = fixtures()
        pages[0]['images'].append(image('chief', 166, 32))
        result = extract(pages, PROFILE)
        self.assertEqual(result['coverage'], {'from': '2026-11-28', 'to': '2026-12-04'})
        self.assertIn('2026-12-01', [e['date'] for e in result['events']])
        self.assertEqual(len(result['events']), 3)
        self.assertTrue(all('durationDays' not in e for e in result['events']))

    def test_duplicate_paint_does_not_duplicate_event(self):
        pages = fixtures()
        pages[0]['images'].append(deepcopy(pages[0]['images'][0]))
        result = extract(pages, PROFILE)
        self.assertEqual(len(result['events']), 2)
        self.assertEqual(result['statistics']['duplicateEventsIgnored'], 1)

    def test_image_spanning_dates_is_not_forced_into_one_day_or_duration(self):
        pages = fixtures()
        pages[0]['images'].append(image('chief', 126, 32, width=35))
        result = extract(pages, PROFILE)
        self.assertEqual(len(result['events']), 2)
        self.assertEqual(result['ambiguities'][0]['reason'], 'image-spans-date-columns')

    def test_unknown_image_is_held_with_coordinates(self):
        pages = fixtures()
        pages[0]['images'].append(image('new-unmapped-image', 126, 32))
        result = extract(pages, PROFILE)
        self.assertEqual(len(result['events']), 2)
        self.assertEqual(result['ambiguities'][0]['reason'], 'unknown-or-conflicting-image')
        self.assertEqual(result['ambiguities'][0]['date'], '2026-11-29')
        self.assertIn('bbox', result['ambiguities'][0])

    def test_all_unknown_images_still_produce_an_ambiguity_report(self):
        pages = fixtures()
        for placement in pages[0]['images']:
            placement['fingerprint'] = 'unknown'
        result = extract(pages, PROFILE)
        self.assertEqual(result['events'], [])
        self.assertEqual(len(result['ambiguities']), 2)

    def test_gear_request_marker_is_not_a_second_champion_event(self):
        pages = fixtures()
        pages.append({'page': 3, 'rects': [], 'words': [word('Champions', 2, 1),
                      word('Gear Requested', 100, 1), word('Argon', 2, 25)],
                      'images': [image('argon', 50, 20, 20), image('request', 100, 20, 20)]})
        pages[0]['images'] += [image('argon', 126, 32), image('request', 126, 44)]
        result = extract(pages, PROFILE)
        self.assertEqual(len(result['events']), 3)
        self.assertEqual(len(result['nonEventMarkers']), 1)

    def test_full_moon_header_preserves_date_only_without_midnight_invention(self):
        pages = fixtures()
        pages.append({'page': 3, 'rects': [], 'words': [word('Events', 80, 1),
                      word('Full Moon', 80, 25)], 'images': [image('moon', 10, 20, 20)]})
        pages[0]['images'].append(image('moon', 106, 20))
        result = extract(pages, PROFILE)
        moon = next(e for e in result['events'] if e['category'] == 'full-moon')
        self.assertNotIn('timeUtc', moon)
        self.assertNotIn('durationDays', moon)

    def test_conflicting_reference_labels_never_pick_first(self):
        pages = fixtures()
        other = deepcopy(pages[1])
        other['page'] = 3
        other['words'][1]['text'] = 'Greater Anubis'
        pages.append(other)
        result = extract(pages, PROFILE)
        self.assertEqual(len(result['events']), 1)
        self.assertEqual(result['ambiguities'][0]['reason'], 'unknown-or-conflicting-image')

    def test_header_tower_is_presence_not_an_event_start(self):
        pages = fixtures()
        pages.append({'page': 3, 'rects': [], 'words': [word('Events', 80, 1),
                      word('Tower Of Titans', 80, 25)],
                      'images': [image('tower', 10, 20, 20)]})
        pages[0]['images'].append(image('tower', 106, 20))
        result = extract(pages, PROFILE)
        self.assertEqual(len(result['events']), 2)
        self.assertEqual(len(result['headerObservations']), 1)

    def test_14_hour_marker_is_not_fabricated_as_a_start(self):
        pages = fixtures()
        pages.append({'page': 3, 'rects': [], 'words': [word('Events', 80, 1),
                      word('24 Hour Modifier Event', 80, 25)],
                      'images': [image('modifier', 10, 20, 20)]})
        grid = calendar_grid(pages[0])
        for hour, x in [('14:00', 106), ('15:00', 126)]:
            band = next(b for b in grid['bands'] if b['timeUtc'] == hour)
            pages[0]['images'].append(image('modifier', x, band['top']+2))
        result = extract(pages, PROFILE)
        self.assertEqual(result['ambiguities'][0]['reason'], 'start-versus-end-marker-unproven')
        modifiers = [e for e in result['events'] if e['category'] == 'modifier-24-hour']
        self.assertEqual(len(modifiers), 1)
        self.assertEqual(modifiers[0]['timeUtc'], '15:00')
        self.assertEqual(modifiers[0]['durationDays'], 1)

    def test_missing_images_fails_closed(self):
        pages = fixtures()
        pages[0]['images'] = []
        with self.assertRaisesRegex(ExtractionError, 'no image'):
            extract(pages, PROFILE)

    def test_missing_hour_geometry_never_guesses_nearest_label(self):
        pages = fixtures()
        pages[0]['rects'] = []
        with self.assertRaisesRegex(ExtractionError, 'geometry'):
            extract(pages, PROFILE)

    def test_invalid_or_truncated_pdf_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'bad.pdf'
            for data in [b'not a PDF', b'%PDF-1.7\ninvalid']:
                path.write_bytes(data)
                with self.assertRaises(ExtractionError):
                    read_pdf(path)

    def test_date_reference_tables_do_not_pollute_image_legend(self):
        pages = fixtures()
        pages.append({'page': 3, 'rects': [], 'words': [word('Full Moons Content Pass Guest Champions', 80, 1),
                      word('2026/11/28', 80, 25)],
                      'images': [image('chief', 10, 20, 20)]})
        result = extract(pages, PROFILE)
        self.assertEqual(result['ambiguities'], [])

    def test_non_utc_or_incomplete_hour_columns_fail(self):
        pages = fixtures()
        pages[0]['words'][0]['text'] = '(local)'
        with self.assertRaisesRegex(ExtractionError, 'UTC'):
            extract(pages, PROFILE)
        pages = fixtures()
        pages[0]['words'] = [w for w in pages[0]['words'] if w['text'] != '23:00']
        with self.assertRaisesRegex(ExtractionError, 'hour column'):
            extract(pages, PROFILE)


if __name__ == '__main__':
    unittest.main()
