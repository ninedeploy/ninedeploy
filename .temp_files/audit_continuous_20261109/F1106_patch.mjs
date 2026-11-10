import fs from 'node:fs';const p='apps/server/src/plugins/backupScheduler.ts';fs.copyFileSync(p,'.temp_files/audit_continuous_20261109/F1106_backupScheduler_before.ts');let s=fs.readFileSync(p,'utf8').replaceAll('\r\n','\n');
function replace(a,b){if(!s.includes(a))throw Error('Missing source anchor '+a.slice(0,60));s=s.replace(a,b);}
replace('    const inFlight = new Set<number>();','    const inFlight = new Set<number>();\n    let policyReadVersion = 0;\n    let completedPolicyRefresh = 0;\n    const policyVersions = new Map<number, number>();');
replace('    const resyncPolicies = async () => {\n      let policies:',`    // Reads can finish out of order; one database's save must not cancel another's.
    function publishPolicy(databaseId: number, policy: DatabaseBackupPolicy | undefined, version: number): boolean {
      if (!running || version < completedPolicyRefresh || version < (policyVersions.get(databaseId) ?? 0)) return false;
      policyVersions.set(databaseId, version);
      armPolicy(databaseId, policy);
      return true;
    }

    const resyncPolicies = async () => {
      const version = ++policyReadVersion;
      let policies:`);
replace('      if (!running) return;\n      for (const id of [...policyCrons.keys()]) if (!policies.has(id)) armPolicy(id, undefined);\n      for (const [id, p] of policies) armPolicy(id, p);','      if (!running || version < completedPolicyRefresh) return;\n      completedPolicyRefresh = version;\n      for (const id of [...policyCrons.keys()]) if (!policies.has(id)) publishPolicy(id, undefined, version);\n      for (const [id, p] of policies) publishPolicy(id, p, version);');
replace('    const onPolicyChanged = (databaseId: number) => {\n      void (async () => {','    const onPolicyChanged = (databaseId: number) => {\n      const version = ++policyReadVersion;\n      policyVersions.set(databaseId, version);\n      void (async () => {');
replace("          armPolicy(databaseId, policies.get(databaseId));\n          fastify.log.info({ databaseId }, 'backup policy re-armed');", "          if (publishPolicy(databaseId, policies.get(databaseId), version)) {\n            fastify.log.info({ databaseId }, 'backup policy re-armed');\n          }");
replace('      policyCrons.clear();\n    });','      policyCrons.clear();\n      policyVersions.clear();\n    });');
replace('    let bootPolicies = new Map<number, DatabaseBackupPolicy>();','    let bootPolicies = new Map<number, DatabaseBackupPolicy>();\n    const bootPolicyVersion = ++policyReadVersion;');
replace('    for (const [id, p] of bootPolicies) armPolicy(id, p);','    for (const [id, p] of bootPolicies) publishPolicy(id, p, bootPolicyVersion);');
fs.writeFileSync(p,s);
