// Generated from the unchanged TitansHub runtime schema.
import { z } from 'zod';
import { isCalendarDate } from './date-validation.mjs';
export const calendarRemoteDatasetSchemaVersion = 1;
export const calendarRemoteDatasetUrl = 'https://raw.githubusercontent.com/Loghlas/TitansHub-Releases/main/calendar.json';
export const septemberAndOctober2026RemoteCalendarUpdatedAt = '2026-09-30T00:00:00.000Z';
const calendarCategories = [
    'content-pass',
    'blitz-pass',
    'lost-city-of-gold',
    'kings-caprice',
    'tower-of-titans',
    'dragon-invasion',
    'modifier-24-hour',
    'modifier-48-hour',
    'full-moon',
    'flash-quest',
    'guest-champion',
    'boss',
    'champion',
    'unknown',
];
const nonEmptyIdentifier = z.string().trim().min(1).max(180);
const calendarDate = z.string().refine(isCalendarDate, 'Expected an ISO calendar date.');
const utcTimestamp = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'Expected an RFC 3339 UTC timestamp.')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'Expected a valid UTC timestamp.');
const remoteCalendarAllDayEventSchema = z
    .object({
    id: nonEmptyIdentifier,
    category: z.enum(calendarCategories),
    title: nonEmptyIdentifier,
    canonicalName: nonEmptyIdentifier.optional(),
    definitionId: nonEmptyIdentifier.optional(),
    allDay: z.literal(true),
    date: calendarDate,
})
    .strict();
const remoteCalendarTimedEventSchema = z
    .object({
    id: nonEmptyIdentifier,
    category: z.enum(calendarCategories),
    title: nonEmptyIdentifier,
    canonicalName: nonEmptyIdentifier.optional(),
    definitionId: nonEmptyIdentifier.optional(),
    allDay: z.literal(false),
    startsAt: utcTimestamp,
    endsAt: utcTimestamp.optional(),
    durationDays: z.number().finite().positive().max(366).optional(),
})
    .strict()
    .superRefine((event, context) => {
    if (event.endsAt !== undefined && Date.parse(event.endsAt) < Date.parse(event.startsAt)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['endsAt'],
            message: 'The event end must not precede its start.',
        });
    }
});
const remoteCalendarEventSchema = z.discriminatedUnion('allDay', [
    remoteCalendarAllDayEventSchema,
    remoteCalendarTimedEventSchema,
]);
export const calendarRemoteDatasetSchema = z
    .object({
    schemaVersion: z.literal(calendarRemoteDatasetSchemaVersion),
    updatedAt: utcTimestamp,
    timezone: z.literal('UTC'),
    coverage: z
        .object({ from: calendarDate, to: calendarDate })
        .strict()
        .refine((coverage) => coverage.from <= coverage.to, {
        message: 'The coverage end must not precede its start.',
        path: ['to'],
    }),
    events: z.array(remoteCalendarEventSchema).min(1).max(2_000),
})
    .strict()
    .superRefine((dataset, context) => {
    const ids = new Set();
    for (const [index, event] of dataset.events.entries()) {
        if (ids.has(event.id)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['events', index, 'id'],
                message: 'Calendar event IDs must be unique.',
            });
        }
        ids.add(event.id);
        const startDate = event.allDay ? event.date : event.startsAt.slice(0, 10);
        const endDate = event.allDay ? event.date : (event.endsAt ?? event.startsAt).slice(0, 10);
        if (startDate > dataset.coverage.to || endDate < dataset.coverage.from) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['events', index],
                message: 'Each event must intersect the declared coverage period.',
            });
        }
    }
});
export function parseCalendarRemoteDataset(value) {
    let raw;
    try {
        raw = JSON.parse(value);
    }
    catch {
        return {
            ok: false,
            code: 'invalid-json',
            message: 'The remote calendar is not valid JSON.',
        };
    }
    if (typeof raw === 'object' &&
        raw !== null &&
        'schemaVersion' in raw &&
        raw.schemaVersion !== calendarRemoteDatasetSchemaVersion) {
        return {
            ok: false,
            code: 'unsupported-schema',
            message: 'The remote calendar uses an unsupported schema version.',
        };
    }
    const parsed = calendarRemoteDatasetSchema.safeParse(raw);
    return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            code: 'invalid-calendar-data',
            message: 'The remote calendar does not match the supported schema.',
        };
}
export function createCalendarRemoteDataset(dataset, metadata) {
    const candidate = {
        schemaVersion: calendarRemoteDatasetSchemaVersion,
        updatedAt: metadata.updatedAt,
        timezone: 'UTC',
        coverage: metadata.coverage,
        events: dataset.occurrences.map(toRemoteEvent),
    };
    const parsed = calendarRemoteDatasetSchema.parse(candidate);
    return parsed;
}
/**
 * Replaces only the period covered by an audited incoming reference while
 * retaining all historical events outside it. This is the monthly generator's
 * append/update boundary; it never silently shrinks the published history.
 */
export function mergeCalendarRemoteDatasets(existing, incoming) {
    const retained = existing.events.filter((event) => !eventIntersectsCoverage(event, incoming.coverage));
    return calendarRemoteDatasetSchema.parse({
        schemaVersion: calendarRemoteDatasetSchemaVersion,
        updatedAt: existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt,
        timezone: 'UTC',
        coverage: {
            from: existing.coverage.from < incoming.coverage.from
                ? existing.coverage.from
                : incoming.coverage.from,
            to: existing.coverage.to > incoming.coverage.to ? existing.coverage.to : incoming.coverage.to,
        },
        events: [...retained, ...incoming.events].sort((left, right) => left.id.localeCompare(right.id)),
    });
}
function eventIntersectsCoverage(event, coverage) {
    const start = event.allDay ? event.date : event.startsAt.slice(0, 10);
    const end = event.allDay ? event.date : (event.endsAt ?? event.startsAt).slice(0, 10);
    return start <= coverage.to && end >= coverage.from;
}
export function remoteCalendarDatasetToOccurrences(dataset) {
    return dataset.events.map((event) => {
        const common = {
            id: event.id,
            category: event.category,
            ...(event.canonicalName === undefined ? {} : { canonicalName: event.canonicalName }),
            ...(event.definitionId === undefined ? {} : { definitionId: event.definitionId }),
            title: event.title,
            dateSemantics: 'remote-calendar-json',
            sourceType: 'remote-calendar-json',
            reliability: 'remote-validated-calendar',
            timezone: dataset.timezone,
            provenance: [
                {
                    sourceType: 'remote-calendar-json',
                    reliability: 'remote-validated-calendar',
                    sourceUrl: calendarRemoteDatasetUrl,
                    observedAt: dataset.updatedAt,
                    note: `calendar.json schema v${dataset.schemaVersion}.`,
                },
            ],
            sourceUrl: calendarRemoteDatasetUrl,
            warnings: [],
        };
        if (event.allDay) {
            return {
                ...common,
                startDate: event.date,
                precision: 'date',
            };
        }
        return {
            ...common,
            startDate: event.startsAt,
            startAt: event.startsAt,
            ...(event.endsAt === undefined ? {} : { endDate: event.endsAt, endAt: event.endsAt }),
            ...(event.durationDays === undefined ? {} : { durationDays: event.durationDays }),
            precision: 'datetime',
        };
    });
}
export function remoteCalendarDatasetToDefinitions(dataset) {
    const definitions = new Map();
    for (const event of dataset.events) {
        if (event.definitionId === undefined || definitions.has(event.definitionId))
            continue;
        definitions.set(event.definitionId, {
            id: event.definitionId,
            category: event.category,
            canonicalName: event.canonicalName ?? event.title,
            sourceType: 'remote-calendar-json',
            reliability: 'remote-validated-calendar',
            provenance: {
                sourceType: 'remote-calendar-json',
                reliability: 'remote-validated-calendar',
                sourceUrl: calendarRemoteDatasetUrl,
                observedAt: dataset.updatedAt,
            },
            warnings: [],
        });
    }
    return {
        items: [...definitions.values()],
        warnings: [],
        status: remoteCalendarDatasetStatus(dataset),
    };
}
export function remoteCalendarDatasetStatus(dataset) {
    return {
        sourceType: 'remote-calendar-json',
        availability: 'available',
        fetchedAt: dataset.updatedAt,
        provenance: {
            sourceType: 'remote-calendar-json',
            reliability: 'remote-validated-calendar',
            sourceUrl: calendarRemoteDatasetUrl,
            observedAt: dataset.updatedAt,
        },
    };
}
function toRemoteEvent(occurrence) {
    const shared = {
        id: occurrence.id,
        category: occurrence.category,
        title: occurrence.title,
        ...(occurrence.canonicalName === undefined ? {} : { canonicalName: occurrence.canonicalName }),
        ...(occurrence.definitionId === undefined ? {} : { definitionId: occurrence.definitionId }),
    };
    if (occurrence.precision === 'date') {
        return { ...shared, allDay: true, date: occurrence.startDate };
    }
    const startsAt = occurrence.startAt ?? occurrence.startDate;
    return {
        ...shared,
        allDay: false,
        startsAt,
        ...((occurrence.endAt ?? occurrence.endDate)
            ? { endsAt: occurrence.endAt ?? occurrence.endDate }
            : {}),
        ...(occurrence.durationDays === undefined ? {} : { durationDays: occurrence.durationDays }),
    };
}
