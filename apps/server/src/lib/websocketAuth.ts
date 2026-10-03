/** Extract a bearer token from the WebSocket subprotocol header.
 *
 * Browser WebSocket APIs cannot set Authorization, but subprotocols are sent
 * in headers rather than URLs, keeping credentials out of proxy access logs
 * and request history.
 *
 * L-3: the `?token=` fallback that used to back this up is gone. The app's own
 * logger strips query strings, but Traefik sits in front with `accessLog: {}`
 * enabled (`engine/proxy.ts`) and logs the full request line, and browser
 * history keeps the URL too — so the fallback wrote a live session token to
 * two places that outlive the connection. Every first-party client (the web
 * app, and the CLI's `deploys watch`) sends the subprotocol form.
 */
export function websocketBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['sec-websocket-protocol'];
  const protocols = (Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').map((value) => value.trim());
  const bearer = protocols.find((value) => value.startsWith('ninedeploy.bearer.'));
  return bearer?.slice('ninedeploy.bearer.'.length) || undefined;
}
