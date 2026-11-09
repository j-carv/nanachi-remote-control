import { z } from 'zod';

/**
 * Languages the app is translated into. The protocol owns the list: the PWA shows its interface in these languages and
 * the daemon writes the Web Push texts in them. The first entry is the default (pt-BR).
 */
export const APP_LANGUAGES = ['pt-BR', 'en', 'es'] as const;

export const AppLanguageSchema = z.enum(APP_LANGUAGES);

export type AppLanguage = z.infer<typeof AppLanguageSchema>;
