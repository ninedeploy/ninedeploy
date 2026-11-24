import { createDatabase, createService, hasImportServiceSource, slugifyResourceName, type ImportPlan } from '@ninedeploy/schemas';

type ProblemCode = 'existingName' | 'repeatedName' | 'repeatedRef' | 'missingSource' | 'unsupportedEngine' | 'invalidSettings';
type Entry = { ref: string; name: string; slug: string; problem?: ProblemCode; fields?: string[] };

export function checkImportTarget(plan: ImportPlan, inventory: { services: Array<{ slug: string }>; databases: Array<{ slug: string }> }) {
  const services = plan.services.map((item): Entry => {
    const entry = { ref: item.ref, name: item.create.name, slug: slugifyResourceName(item.create.name) };
    if (!hasImportServiceSource(item)) return { ...entry, problem: 'missingSource' };
    const result = createService.safeParse(item.create);
    if (result.success) return entry;
    return { ...entry, problem: 'invalidSettings', fields: result.error.issues.map((issue) => issue.path.join('.')) };
  });
  const databases = plan.databases.map((item): Entry => {
    const entry = { ref: item.ref, name: item.name, slug: slugifyResourceName(item.name) };
    if (item.engine === null) return { ...entry, problem: 'unsupportedEngine' };
    const result = createDatabase.safeParse({ name: item.name, engine: item.engine });
    if (result.success) return entry;
    return { ...entry, problem: 'invalidSettings', fields: result.error.issues.map((issue) => issue.path.join('.')) };
  });

  return (['service', 'database'] as const).flatMap((kind) => {
    const entries = kind === 'service' ? services : databases;
    const taken = new Set((kind === 'service' ? inventory.services : inventory.databases).map(({ slug }) => slug));
    const refs = new Map<string, number>();
    const names = new Map<string, number>();
    for (const entry of entries) {
      refs.set(entry.ref, (refs.get(entry.ref) ?? 0) + 1);
      if (entry.problem !== 'missingSource' && entry.problem !== 'unsupportedEngine') {
        names.set(entry.slug, (names.get(entry.slug) ?? 0) + 1);
      }
    }
    return entries.flatMap((entry) => {
      const problems: ProblemCode[] = [];
      if (entry.problem) problems.push(entry.problem);
      if (entry.problem !== 'missingSource' && entry.problem !== 'unsupportedEngine') {
        if (taken.has(entry.slug)) problems.push('existingName');
        if ((names.get(entry.slug) ?? 0) > 1) problems.push('repeatedName');
      }
      if ((refs.get(entry.ref) ?? 0) > 1) problems.push('repeatedRef');
      if (!problems.length) return [];
      return [{ ...entry, kind, problems }];
    });
  });
}
