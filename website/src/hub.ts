/**
 * The template hub, straight from the server's registry bundle.
 *
 * One import, one source of truth: every count shown on this site
 * (footer, Home, Features, FAQ, the /templates page) derives from the
 * same JSON the panel ships, so the marketing surface cannot drift from
 * the product the way a hand-written "88 templates" did.
 */
import registry from "../../apps/server/src/templates/registry.json";

export interface HubTemplateEnv {
  key: string;
  value: string;
  secret?: boolean;
}

export interface HubTemplate {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  emoji: string;
  image: string;
  port: number;
  volumeMount?: string | null;
  env?: HubTemplateEnv[];
  website?: string;
  docs?: string;
  featured?: boolean;
  runtimeVerified?: boolean;
  verifiedAt?: string;
  requires?: string;
  dbEngine?: string;
  dockerSocket?: boolean;
  composeContent?: string;
  composeService?: string;
  cmd?: string[];
}

interface RegistryBundle {
  version: number;
  updated?: string;
  templates: HubTemplate[];
}

const bundle = registry as unknown as RegistryBundle;

/** Featured first, then alphabetical — the order the hub page renders. */
export const hubTemplates: HubTemplate[] = [...bundle.templates].sort((a, b) => {
  if (!!a.featured !== !!b.featured) return a.featured ? -1 : 1;
  return a.name.localeCompare(b.name);
});

export const templateCount = hubTemplates.length;
export const certifiedCount = hubTemplates.filter((t) => t.runtimeVerified === true).length;
export const hubUpdated = bundle.updated;

export interface HubCategory {
  name: string;
  count: number;
}

export const hubCategories: HubCategory[] = Object.entries(
  hubTemplates.reduce<Record<string, number>>((acc, t) => {
    acc[t.category] = (acc[t.category] ?? 0) + 1;
    return acc;
  }, {}),
)
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

export const templateNames = hubTemplates.map((t) => t.name);
