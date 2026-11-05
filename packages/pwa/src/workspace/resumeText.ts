import type { AgentSessionSummary } from '@nanachi/shared';
import { currentLanguage, t, type Language } from '../i18n/index.js';

/**
 * Date and time of an untitled session, per language: 03/11/2026 and 09:05 in Portuguese and Spanish, Nov 3, 2026 and
 * 9:05 AM in English.
 */
const DATE_FORMAT: Record<Language, Intl.DateTimeFormatOptions> = {
  'pt-BR': { day: '2-digit', month: '2-digit', year: 'numeric' },
  en: { day: 'numeric', month: 'short', year: 'numeric' },
  es: { day: '2-digit', month: '2-digit', year: 'numeric' },
};
const TIME_FORMAT: Record<Language, Intl.DateTimeFormatOptions> = {
  'pt-BR': { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  en: { hour: 'numeric', minute: '2-digit' },
  es: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

/**
 * Name of an agent session in the "Retomar do PC" list: the agent's own title, or "Sessão de <date> às <time>" /
 * "Session from <date> at <time>" / "Sesión del <date> a las <time>" when the agent gave none. The same text is saved as the title of the imported
 * session, so what the user sees is what the new session is called.
 */
export function listedSessionTitle(item: Pick<AgentSessionSummary, 'title' | 'updatedAt'>): string {
  if (item.title !== null) return item.title;
  if (item.updatedAt === null) return t('workspace:resume.untitled');
  const language = currentLanguage();
  const when = new Date(item.updatedAt);
  return t('workspace:resume.sessionOf', {
    date: new Intl.DateTimeFormat(language, DATE_FORMAT[language]).format(when),
    time: new Intl.DateTimeFormat(language, TIME_FORMAT[language]).format(when),
  });
}
