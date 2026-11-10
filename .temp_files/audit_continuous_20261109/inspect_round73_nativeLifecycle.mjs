import { createDb, runMigrations } from '../../packages/db/dist/index.js';
const count = 50;
for (let index = 0; index < count; index++) {
 const connection = createDb({url:'file::memory:'});
 try { await connection.ready; await runMigrations(connection.db); await connection.client.execute('SELECT name FROM sqlite_master'); }
 finally {connection.client.close();}
 if(process.argv.includes('--force-gc'))globalThis.gc?.();
 console.log('closed owned connection',index+1);
}
console.log('NATIVE LIFECYCLE CONTROL COMPLETED',count);
