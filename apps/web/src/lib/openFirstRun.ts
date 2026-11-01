import type { Template } from '@ninedeploy/sdk';
import { msg } from './i18n.js';

/**
 * The warning for a template whose upstream app is open to whoever reaches
 * it first (`openFirstRun` in the Hub registry). The English text is the
 * translation key. A template that also controls the host's Docker says so,
 * because whoever gets in first then controls the server.
 */
export function openFirstRunWarning(template: Pick<Template, 'openFirstRun' | 'dockerSocket'> | null | undefined): string | null {
  switch (template?.openFirstRun) {
    case 'first-visitor-admin':
      return template.dockerSocket
        ? msg('Until it is set up, the first person to open this app becomes its administrator, and it controls Docker on this server. Finish the setup right after deploying, before its address is reachable by anyone else.')
        : msg('Until it is set up, the first person to open this app becomes its administrator or runs its installer. Finish the setup right after deploying, before you share its address.');
    case 'default-login':
      return msg('This app starts with a publicly known login. Change it right after deploying, before you share its address.');
    case 'open-signup':
      return msg('This app lets anyone create an account by default. Turn sign-up off in its settings or environment if it should stay private.');
    case 'no-auth':
      return template.dockerSocket
        ? msg('This app has no login of its own and can see Docker on this server: anyone who reaches its address sees every container. Keep it off a public domain or put it behind authentication.')
        : msg('This app has no login of its own: anyone who reaches its address can use it. Keep it off a public domain or put it behind authentication.');
    default:
      return null;
  }
}
