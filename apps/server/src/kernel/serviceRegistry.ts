import type { IDomainProvider, IBuildCache, IEgressIpDriver, IOrchestrator, IServiceRegistry } from './types.js';

export class ServiceRegistry implements IServiceRegistry {
  private readonly services = new Map<string, unknown>();
  private readonly domainProviders: IDomainProvider[] = [];
  private readonly buildCaches: IBuildCache[] = [];
  private readonly orchestrators: IOrchestrator[] = [];
  private readonly egressIpDrivers: IEgressIpDriver[] = [];

  register<T>(name: string, service: T): void {
    if (this.services.has(name)) {
      throw new Error(`Service "${name}" is already registered`);
    }
    this.services.set(name, service);
  }

  get<T>(name: string): T {
    const service = this.services.get(name);
    if (service === undefined) {
      throw new Error(`Service "${name}" is not registered in the kernel registry`);
    }
    return service as T;
  }

  getOptional<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  unregister(name: string): boolean {
    const service = this.services.get(name);
    if (!this.services.delete(name)) return false;
    // F368: a typed driver also lives in its parallel list index. Deleting
    // only the map entry left list*() returning the unregistered instance
    // (and `list*()[0]` defaults kept using it) while get*() returned
    // undefined, and refused any replacement under that name forever.
    const indexes: Array<[string, Array<unknown>]> = [
      ['domain:', this.domainProviders],
      ['build-cache:', this.buildCaches],
      ['orchestrator:', this.orchestrators],
      ['egress-ip:', this.egressIpDrivers],
    ];
    for (const [prefix, index] of indexes) {
      if (!name.startsWith(prefix)) continue;
      const at = index.indexOf(service);
      if (at !== -1) index.splice(at, 1);
    }
    return true;
  }

  clear(): void {
    this.services.clear();
    // The domain-provider index is a parallel list; without this reset a
    // `clear()` would leave stale drivers visible via `listDomainProviders`
    // while `getDomainProvider` already returned undefined. Pin the
    // contract: a clear wipes both the typed-driver map AND the index.
    this.domainProviders.length = 0;
    // Same reasoning applies to the build-cache index — see above.
    this.buildCaches.length = 0;
    // And to the orchestrator index (Sprint 4 G-10).
    this.orchestrators.length = 0;
    // And to the egress-IP index (Sprint 5 G-15).
    this.egressIpDrivers.length = 0;
  }

  registerCompute(driver: import('./types.js').IComputeDriver): void {
    this.register(`compute:${driver.name}`, driver);
  }

  getCompute(name: string): import('./types.js').IComputeDriver | undefined {
    return this.getOptional(`compute:${name}`);
  }

  registerProxy(driver: import('./types.js').IProxyDriver): void {
    this.register(`proxy:${driver.name}`, driver);
  }

  getProxy(name: string): import('./types.js').IProxyDriver | undefined {
    return this.getOptional(`proxy:${name}`);
  }

  registerStorage(driver: import('./types.js').IStorageDriver): void {
    this.register(`storage:${driver.name}`, driver);
  }

  getStorage(name: string): import('./types.js').IStorageDriver | undefined {
    return this.getOptional(`storage:${name}`);
  }

  registerDomainProvider(driver: IDomainProvider): void {
    if (this.domainProviders.some((d) => d.name === driver.name)) {
      throw new Error(`Domain provider "${driver.name}" is already registered`);
    }
    // F369: register first — if the key is already taken it throws before
    // the list index is touched, so a refused driver is never listed.
    this.register(`domain:${driver.name}`, driver);
    this.domainProviders.push(driver);
  }

  getDomainProvider(name: string): IDomainProvider | undefined {
    return this.getOptional(`domain:${name}`);
  }

  listDomainProviders(): IDomainProvider[] {
    return [...this.domainProviders];
  }

  registerBuildCache(driver: IBuildCache): void {
    if (this.buildCaches.some((c) => c.name === driver.name)) {
      throw new Error(`Build cache "${driver.name}" is already registered`);
    }
    // F369: register first — if the key is already taken it throws before
    // the list index is touched, so a refused driver is never listed.
    this.register(`build-cache:${driver.name}`, driver);
    this.buildCaches.push(driver);
  }

  getBuildCache(name: string): IBuildCache | undefined {
    return this.getOptional(`build-cache:${name}`);
  }

  listBuildCaches(): IBuildCache[] {
    return [...this.buildCaches];
  }

  registerOrchestrator(driver: IOrchestrator): void {
    if (this.orchestrators.some((o) => o.name === driver.name)) {
      throw new Error(`Orchestrator "${driver.name}" is already registered`);
    }
    // F369: register first — if the key is already taken it throws before
    // the list index is touched, so a refused driver is never listed.
    this.register(`orchestrator:${driver.name}`, driver);
    this.orchestrators.push(driver);
  }

  getOrchestrator(name: string): IOrchestrator | undefined {
    return this.getOptional(`orchestrator:${name}`);
  }

  listOrchestrators(): IOrchestrator[] {
    return [...this.orchestrators];
  }

  registerEgressIpDriver(driver: IEgressIpDriver): void {
    if (this.egressIpDrivers.some((d) => d.name === driver.name)) {
      throw new Error(`Egress IP driver "${driver.name}" is already registered`);
    }
    // F369: register first — if the key is already taken it throws before
    // the list index is touched, so a refused driver is never listed.
    this.register(`egress-ip:${driver.name}`, driver);
    this.egressIpDrivers.push(driver);
  }

  getEgressIpDriver(name: string): IEgressIpDriver | undefined {
    return this.getOptional(`egress-ip:${name}`);
  }

  listEgressIpDrivers(): IEgressIpDriver[] {
    return [...this.egressIpDrivers];
  }
}
