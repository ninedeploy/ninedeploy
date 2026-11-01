/** Synthetic routed traffic for the isolated primary-network smoke. */
export function primaryNetworkProxyClient(proxy, count, port = 80) {
  return `import http from 'node:http';const rows=[];for(let n=0;n<${count};n++){rows.push(await new Promise((resolve,reject)=>{const q=http.request({hostname:${JSON.stringify(proxy)},port:${port},path:'/',headers:{host:'readiness.invalid'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))});q.setTimeout(3000,()=>q.destroy(Error('proxy timeout')));q.on('error',reject);q.end()}))}console.log(JSON.stringify(rows));`;
}
