const source = JSON.parse('{"__proto__":"opaque-proto","constructor":"opaque-constructor","X-Opaque-Context":"opaque-context"}');
const converted = new Headers(source);
console.log(JSON.stringify({ rawOwnProto: Object.hasOwn(source, '__proto__'), rawProtoValue: source['__proto__'], convertedProto: converted.get('__proto__'), convertedConstructor: converted.get('constructor'), convertedOpaqueContext: converted.get('x-opaque-context') }));
