import { readFileSync, writeFileSync } from 'node:fs';
import { s3Delete, s3Get, s3Put, type S3Config } from '../../lib/s3.js';
import type { IStorageDriver } from '../types.js';

export class S3StorageDriver implements IStorageDriver {
  readonly name = 's3';
  private readonly config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
  }

  async upload(localPath: string, remoteKey: string): Promise<void> {
    const data = readFileSync(localPath);
    await s3Put(this.config, remoteKey, data);
  }

  async download(remoteKey: string, localDestPath: string): Promise<void> {
    const data = await s3Get(this.config, remoteKey);
    writeFileSync(localDestPath, data);
  }

  async delete(remoteKey: string): Promise<void> {
    await s3Delete(this.config, remoteKey);
  }
}
