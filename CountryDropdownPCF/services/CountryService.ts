/**
 * Loads country rows from a configurable Dataverse table through the PCF Web API.
 *
 * - Uses context.webAPI.retrieveMultipleRecords (runs as the current user, so
 *   Dataverse security roles are always respected).
 * - Validates logical names before they are placed in the OData query.
 * - Follows @odata.nextLink pagination.
 * - Retries throttled requests with exponential back-off.
 * - De-duplicates concurrent requests for the same configuration (e.g. two
 *   instances of the control on one form share one network call) and caches
 *   the result for the page lifetime.
 */

export interface CountryConfig {
    tableName: string;
    nameColumn: string;
    codeColumn?: string;
    activeOnly: boolean;
}

export interface Country {
    /** Stable key for React lists (record id when available). */
    id: string;
    name: string;
    code?: string;
}

export type CountryErrorKind =
    | "config"
    | "tableNotFound"
    | "columnNotFound"
    | "permission"
    | "throttled"
    | "network"
    | "unknown";

export class CountryLoadError extends Error {
    public readonly kind: CountryErrorKind;
    public readonly detail?: string;

    constructor(kind: CountryErrorKind, message: string, detail?: string) {
        super(message);
        this.name = "CountryLoadError";
        this.kind = kind;
        this.detail = detail;
        Object.setPrototypeOf(this, CountryLoadError.prototype);
    }
}

/** Dataverse page size. 5000 is the platform maximum. */
const PAGE_SIZE = 5000;
/** Safety cap so a misconfigured table can never cause an endless loop. */
const MAX_PAGES = 20;
const MAX_RETRIES = 3;
const LOGICAL_NAME = /^[a-z][a-z0-9_]{0,127}$/;

const cache = new Map<string, Promise<Country[]>>();

export function normaliseConfig(raw: {
    tableName?: string | null;
    nameColumn?: string | null;
    codeColumn?: string | null;
    activeOnly?: boolean;
}): CountryConfig {
    const clean = (v?: string | null): string => (v ?? "").trim().toLowerCase();
    const code = clean(raw.codeColumn);
    return {
        tableName: clean(raw.tableName),
        nameColumn: clean(raw.nameColumn),
        codeColumn: code.length > 0 ? code : undefined,
        activeOnly: raw.activeOnly !== false,
    };
}

export function configKey(c: CountryConfig): string {
    return [c.tableName, c.nameColumn, c.codeColumn ?? "", c.activeOnly ? "1" : "0"].join("|");
}

export function validateConfig(c: CountryConfig): void {
    if (!c.tableName) {
        throw new CountryLoadError("config", "Country table logical name is not configured.");
    }
    if (!c.nameColumn) {
        throw new CountryLoadError("config", "Country name column logical name is not configured.");
    }
    const bad = [c.tableName, c.nameColumn, c.codeColumn]
        .filter((n): n is string => !!n)
        .filter((n) => !LOGICAL_NAME.test(n));
    if (bad.length > 0) {
        throw new CountryLoadError(
            "config",
            `Invalid logical name(s): ${bad.join(", ")}. Use the lowercase logical name (e.g. new_country), not the display name.`,
        );
    }
}

export function buildQuery(c: CountryConfig): string {
    const select = [c.nameColumn, c.codeColumn].filter(Boolean).join(",");
    const filters = [`${c.nameColumn} ne null`];
    if (c.activeOnly) {
        filters.push("statecode eq 0");
    }
    // Names are validated against LOGICAL_NAME, so only the OData expressions
    // (spaces etc.) need encoding.
    return (
        `?$select=${encodeURIComponent(select)}` +
        `&$filter=${encodeURIComponent(filters.join(" and "))}` +
        `&$orderby=${encodeURIComponent(`${c.nameColumn} asc`)}`
    );
}

/** Loads (or returns the cached / in-flight) country list for a configuration. */
export function loadCountries(
    webAPI: ComponentFramework.WebApi,
    config: CountryConfig,
): Promise<Country[]> {
    validateConfig(config);
    const key = configKey(config);
    const existing = cache.get(key);
    if (existing) {
        return existing;
    }
    const promise = fetchAll(webAPI, config).catch((err: unknown) => {
        // Never cache failures: the next attempt (e.g. Retry button) refetches.
        cache.delete(key);
        throw err;
    });
    cache.set(key, promise);
    return promise;
}

/** Drops the cached list so the next load hits Dataverse again. */
export function invalidateCountries(config: CountryConfig): void {
    cache.delete(configKey(config));
}

async function fetchAll(webAPI: ComponentFramework.WebApi, c: CountryConfig): Promise<Country[]> {
    const rows: ComponentFramework.WebApi.Entity[] = [];
    let options: string | undefined = buildQuery(c);
    let pages = 0;

    while (options !== undefined && pages < MAX_PAGES) {
        const page = await withRetry(() =>
            webAPI.retrieveMultipleRecords(c.tableName, options, PAGE_SIZE),
        );
        rows.push(...page.entities);
        pages++;
        options = nextOptions(page.nextLink);
    }

    return toCountries(rows, c);
}

/**
 * retrieveMultipleRecords returns nextLink as an absolute URL. Passing the
 * query string portion back as `options` fetches the next page (it carries
 * the original $select/$filter plus the paging cookie).
 */
function nextOptions(nextLink?: string): string | undefined {
    if (!nextLink) {
        return undefined;
    }
    const q = nextLink.indexOf("?");
    return q >= 0 ? nextLink.substring(q) : undefined;
}

function toCountries(rows: ComponentFramework.WebApi.Entity[], c: CountryConfig): Country[] {
    const seen = new Set<string>();
    const result: Country[] = [];
    const idColumn = `${c.tableName}id`;

    rows.forEach((row, index) => {
        const rawName: unknown = row[c.nameColumn];
        if (typeof rawName !== "string") {
            return;
        }
        const name = rawName.trim();
        if (!name) {
            return;
        }
        const dedupeKey = name.toLocaleLowerCase();
        if (seen.has(dedupeKey)) {
            return; // duplicate country names collapse to one entry
        }
        seen.add(dedupeKey);

        const rawCode: unknown = c.codeColumn ? row[c.codeColumn] : undefined;
        const rawId: unknown = row[idColumn];
        result.push({
            id: typeof rawId === "string" ? rawId : `${index}:${dedupeKey}`,
            name,
            code: typeof rawCode === "string" && rawCode.trim() ? rawCode.trim() : undefined,
        });
    });

    // Server ordering is case/collation dependent; enforce a stable UI order.
    result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return result;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err: unknown) {
            const classified = classifyError(err);
            const retryable = classified.kind === "throttled" || classified.kind === "network";
            if (!retryable || attempt >= MAX_RETRIES) {
                throw classified;
            }
            attempt++;
            await delay(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DataverseErrorShape {
    errorCode?: number;
    code?: number | string;
    status?: number;
    httpStatusCode?: number;
    message?: string;
    raw?: string;
}

/** Maps Web API failures to user-meaningful categories. */
export function classifyError(err: unknown): CountryLoadError {
    if (err instanceof CountryLoadError) {
        return err;
    }
    const e = (typeof err === "object" && err !== null ? err : {}) as DataverseErrorShape;
    const message = (e.message ?? (typeof err === "string" ? err : "")) || "Unknown error";
    const text = `${message} ${e.raw ?? ""}`.toLowerCase();
    const status = e.status ?? e.httpStatusCode;
    const code = e.errorCode;

    if (
        status === 429 ||
        code === -2147015902 || // Number of requests exceeded
        code === -2147015903 || // Combined execution time exceeded
        code === -2147015898 || // Concurrent requests exceeded
        text.includes("rate limit") ||
        text.includes("requests exceeded") ||
        text.includes("throttl")
    ) {
        return new CountryLoadError(
            "throttled",
            "Dataverse is throttling requests. Please wait a moment and retry.",
            message,
        );
    }
    if (
        status === 403 ||
        code === -2147220960 || // principal user is missing privilege
        code === -2147187962 ||
        text.includes("privilege") ||
        text.includes("access is denied")
    ) {
        return new CountryLoadError(
            "permission",
            "You don't have permission to read the country table. Ask your administrator for Read access.",
            message,
        );
    }
    if (
        text.includes("could not find a property named") ||
        text.includes("could not find property") ||
        (text.includes("attribute") && text.includes("does not exist"))
    ) {
        return new CountryLoadError(
            "columnNotFound",
            "A configured column was not found on the country table. Check the name/code column logical names (and set 'Active records only' to No if the table has no statecode).",
            message,
        );
    }
    if (
        status === 404 ||
        text.includes("could not find entity") ||
        text.includes("could not find an entity") ||
        text.includes("resource not found for the segment") ||
        (text.includes("entity") && text.includes("does not exist"))
    ) {
        return new CountryLoadError(
            "tableNotFound",
            "The configured country table was not found. Check the table logical name.",
            message,
        );
    }
    if (status === 0 || text.includes("network") || text.includes("failed to fetch") || text.includes("timeout")) {
        return new CountryLoadError("network", "Network error while loading countries.", message);
    }
    return new CountryLoadError("unknown", "Countries could not be loaded.", message);
}
