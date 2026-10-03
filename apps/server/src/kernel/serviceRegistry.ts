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
    return this.services.delete(name);
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
    this.domainProviders.push(driver);
    this.register(`domain:${driver.name}`, driver);
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
    this.buildCaches.push(driver);
    this.register(`build-cache:${driver.name}`, driver);
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
    this.orchestrators.push(driver);
    this.register(`orchestrator:${driver.name}`, driver);
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
    this.egressIpDrivers.push(driver);
    this.register(`egress-ip:${driver.name}`, driver);
  }

  getEgressIpDriver(name: string): IEgressIpDriver | undefined {
    return this.getOptional(`egress-ip:${name}`);
  }

  listEgressIpDrivers(): IEgressIpDriver[] {
    return [...this.egressIpDrivers];
  }
}
