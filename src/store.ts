/**
 * Barrel re-export for src/store/ module.
 *
 * All public APIs remain at this path for backward compatibility.
 */

export { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs } from "./store/content-store.js";
export { sanitizeQuery, sanitizeTrigramQuery } from "./store/search-helpers.js";
export type { IndexResult, SearchResult, StoreStats } from "./types.js";
