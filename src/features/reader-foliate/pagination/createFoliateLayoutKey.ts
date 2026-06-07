import type { ReaderLayoutProfile } from "./foliatePaginationTypes";

// Returns a stable string key for a layout profile.
// Only non-null/undefined fields are included, sorted alphabetically,
// so adding new optional fields with null values does not invalidate
// existing keys.
export function createFoliateLayoutKey(profile: ReaderLayoutProfile): string {
	const entries = (Object.entries(profile) as [string, unknown][])
		.filter(([, v]) => v !== null && v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(Object.fromEntries(entries));
}
