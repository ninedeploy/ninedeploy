# Ingress, Routing & Cloudflare Tunnels

NineDeploy embeds Traefik as its reverse proxy and ingress controller, providing automated TLS certificates, custom middlewares, and secure tunneling.

---

## 🌐 1. Dynamic Ingress Architecture

- **Automatic Route Generation**: Every deployed service is assigned dynamic Traefik routers based on its domain configurations.
- **Health-Gated Routing**: Traefik only sends traffic to containers marked healthy by NineDeploy's health monitoring loop.
- **WebSocket & HTTP/2 Support**: Native bidirectional streaming for WebSockets, SSE, and HTTP/2 multiplexing.

---

## 🔒 2. Let's Encrypt SSL Certificates

- **HTTP-01 Challenge**: Automatic SSL issuance for apex and subdomains on port 80/443.
- **DNS-01 Challenge**: Automatic wildcard SSL certificates (`*.yourdomain.com`) via Cloudflare, DigitalOcean, Hetzner, Linode, Gandi or DuckDNS DNS API integration.
- **Auto-Renewal**: Traefik automatically renews certificates 30 days before expiration.
- **HTTP → HTTPS**: a domain with SSL on also answers plain HTTP with a redirect to HTTPS (a temporary one, so turning SSL off takes effect). The panel domain does the same once an ACME email is configured.

---

## 🛡️ 3. Middlewares & Rate Limiting

Apply security middlewares directly from the dashboard:
- **IP Allowlisting / Denylisting**: Restrict internal admin services to VPN/office CIDRs.
- **Basic Auth**: Add an extra authentication layer in front of legacy web services. Passwords are stored and rendered as APR1 htpasswd hashes (`user:password` is hashed on save; a pasted `user:$apr1$…` / bcrypt entry is kept as is), and are hidden from viewer seats.
- **Custom Headers & CORS**: Inject HSTS, Content-Security-Policy, and CORS headers automatically.

---

## 🚇 4. Cloudflare Tunnels Integration

Deploy services on private servers, home labs, or NAT-restricted environments without opening public ports or configuring firewall port-forwarding.
- Secure outbound connections to the Cloudflare Edge network.
- DDoS mitigation and global anycast routing.

---

## 🧾 5. Domain claim limits

Operators can tune how domains are claimed with `PUT /v1/settings/domain-policy` (instance operators are exempt from the caps; `0` disables a limit):
- `maxOwnZoneDomainsPerService` (default 50): domains one service may hold inside the instance's own wildcard zone, which need no DNS proof. Existing domains are never removed.
- `maxDomainCreatesPerHour` (default 30): domains one account may add per rolling hour.
- `pendingExpiryDays` (default 30): unverified domains are removed after this many days. A claimant who proves a hostname another service holds only as unverified can take it over: the add request explains the TXT record to publish.
