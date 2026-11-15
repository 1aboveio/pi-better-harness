import { type ThinkingLevel } from "./thinking.mjs";
export type CatalogPreference = Readonly<{
    bundled?: true;
    model?: string | null;
    effort?: ThinkingLevel | null;
}>;
export type CatalogPreferences = Readonly<Record<string, CatalogPreference>>;
export declare function readCatalogPreferences(root: string): {
    settings: CatalogPreferences;
    digest: string;
};
/** Replace only this id's own preferences; null explicitly clears a definition value. */
export declare function writeCatalogPreferences(root: string, id: string, value: CatalogPreference | ((current: CatalogPreference) => CatalogPreference)): {
    path: string;
    settings: CatalogPreferences;
    digest: string;
};
