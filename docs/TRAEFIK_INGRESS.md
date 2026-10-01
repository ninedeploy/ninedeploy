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

---

## 🛡️ 3. Middlewares & Rate Limiting

Apply security middlewares directly from the dashboard:
- **IP Allowlisting / Denylisting**: Restrict internal admin services to VPN/office CIDRs.
- **Basic Auth**: Add an extra authentication layer in front of legacy web services.
- **Custom Headers & CORS**: Inject HSTS, Content-Security-Policy, and CORS headers automatically.

---

## 🚇 4. Cloudflare Tunnels Integration

Deploy services on private servers, home labs, or NAT-restricted environments without opening public ports or configuring firewall port-forwarding.
- Secure outbound connections to the Cloudflare Edge network.
- DDoS mitigation and global anycast routing.
