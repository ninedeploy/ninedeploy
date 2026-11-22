# Framework starters

Deploy a small Next.js, Laravel, or FastAPI application from a local folder. Each example includes a Dockerfile, a dependency lockfile and a `.ninedeploy` manifest that sets the application port and the `/healthz` readiness path.

| Starter | Runtime | Container port |
| --- | --- | ---: |
| [Next.js](../examples/nextjs) | Node.js 24, Next.js standalone server | 3000 |
| [Laravel](../examples/laravel) | PHP 8.4 and Apache | 80 |
| [FastAPI](../examples/fastapi) | Python 3.14 and Uvicorn | 8000 |

## Deploy from your machine

1. Install NineDeploy and finish setup using the [Quickstart](QUICKSTART.md). If the panel must use the sibling prober because it cannot reach container IPs directly, use a build that includes the readiness fix below. Sign in to the CLI with `ninedeploy login`. Your account needs permission to create a service.
2. From the NineDeploy checkout, run the command for the framework you want. Each example directory is also a self-contained project root you can copy into a new repository.

   ```bash
   ninedeploy deploy up ./examples/nextjs --create nextjs-starter
   ninedeploy deploy up ./examples/laravel --create laravel-starter --exclude vendor
   ninedeploy deploy up ./examples/fastapi --create fastapi-starter
   ```

3. Open the service in the panel and wait for the deployment to finish. If a build fails, open its deployment log. Use the service URL to open `/` and confirm the framework's starter message. Request `/healthz` to check for HTTP 200 and `{"status":"ok"}`.
4. For public HTTPS, point a DNS record at your server and add the hostname with HTTPS enabled in the service's Domains tab. Follow the DNS and certificate prerequisites in the [Traefik ingress guide](TRAEFIK_INGRESS.md). If you have no service URL yet, start with an [automatic URL or a custom domain](TRAEFIK_INGRESS.md#automatic-urls-0161).

You can also upload an archive through **New → Upload source**. Put the Dockerfile and `.ninedeploy` at the root of the archive and include the lockfile. Keep credentials and local dependencies outside the archive. [Source upload guide](DEPLOYMENTS.md#deploy-without-git-uploaded-source-0161)

### Recover a failed upload deployment

After **Create and deploy**, the panel opens the service's **Deploys** tab. If a build fails, the deployment output shows the failed step and any error detail recorded for it. Select **Jump to failed step** to find that step in the build log. Review the failing command or check before changing the source.

Use **Upload new version** on the same service to send a corrected archive. This queues a new deployment and keeps the earlier attempt in history. If the upload itself was rejected after the service was created, the panel displays the rejection and opens the same **Deploys** tab so you can upload again there.

On November 22, 2026, the browser journey reproduced the missing **Deploys** hand-off on the previous panel image. On the updated image (`sha256:504f8e892750af3cff0bb7044d67e37dab46b151954579dd3e36d88a828bdf4e`), a disposable Dockerfile exited with code 37 during the first build. The browser opened **Deploys**, showed **Build failed**, and jumped to the step containing the Dockerfile output. A corrected upload reached `running` on the same service, the failed attempt remained in history, and Traefik served the corrected application's response.

## Customize the starter

- **Next.js** uses App Router with `app/page.js` as its entry page. The runtime image copies the standalone server and the generated static assets. If you add a `public/` directory, add a Dockerfile `COPY` for it into the runtime image. Regenerate `package-lock.json` with `npm install` from the project directory when you change dependencies. [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- **Laravel** serves the `public/` directory and registers the example routes in `routes/web.php`. The sample is stateless. When adding sessions or authentication, provide `APP_KEY` through service environment variables and configure persistence for your application. Use PHP 8.4 and run `composer update` from the project directory to regenerate `composer.lock`. [Laravel deployment guide](https://laravel.com/framework/docs/13.x/deployment)
- **FastAPI** serves `main:app` with Uvicorn. Change `requirements.in` and run `uv pip compile requirements.in --python-version 3.14 --universal --generate-hashes --output-file requirements.txt` from the project directory to update the hash-checked lockfile. [FastAPI container guide](https://fastapi.tiangolo.com/deployment/docker/)

## Verify deployments

The **Framework starters** GitHub Actions workflow runs after successful main push CI and uses the panel image from that commit. You can also dispatch it with a candidate image reference. For a local run, use Node.js, `tar` and a local Linux Docker engine that supports a privileged Docker-in-Docker fixture. Network access is required for the framework base images and packages.

```bash
docker build -t ninedeploy:framework-starters .
node scripts/smoke-framework-starters.mjs --image=ninedeploy:framework-starters
```

The smoke registers a disposable operator and uploads each archive through the API used by `ninedeploy deploy up`. It waits for each deployment to finish, checks the manifest-derived port and deployment readiness probe, and requests both application endpoints through the isolated Traefik listener. The run writes `result.json` and the deployment logs under `.temp_files/framework-starters/`. CI uploads equivalent receipts. The fixture uses private HTTP hostnames under `starters.test`.

### Sibling HTTP readiness fix

The released v0.19.0 image deployed Next.js and Laravel in the isolated fixture. FastAPI served HTTP 200 on `/healthz` when requested directly from the same bridge, but the panel's sibling probe received an empty response and timed out the deployment. The probe piped the request into BusyBox `nc`, which shut down the write half of the socket at EOF before Uvicorn's asynchronous request handling completed. The panel now uses the same bidirectional HTTP probe as node readiness. It keeps the socket open through the response status, uses the inspected container IP and keeps the current readiness status policy. [BusyBox `nc` write-half shutdown](https://lists.busybox.net/pipermail/busybox-cvs/2013-July/034115.html)

### Local acceptance on 2026-11-22

The smoke passed on a Linux amd64 panel image built locally from the updated source (`sha256:a138d12a3122d2e45e9b09f4ac4c98009cba9d8f143544108f12cacd1288fb33`). Every deployment passed its readiness check. Traefik returned HTTP 200 with the expected response on `/` and `/healthz` for all three applications. The run confirmed removal of its disposable containers, network and volume.

| Framework | Upload to deployment success | Upload to verified HTTP routes |
| --- | ---: | ---: |
| Next.js | 47.9 s | 50.8 s |
| Laravel | 42.7 s | 46.2 s |
| FastAPI | 22.4 s | 24.5 s |

These timings cover a single run against a fresh isolated Docker daemon. The first hosted framework workflow run is pending.

## Clean-server first deployment

The test starts with a fresh Ubuntu 24.04.5 LTS QEMU/KVM guest with four vCPUs and 3 GiB of memory. It has no Docker installation, NineDeploy state, or cached container images. Run the pinned Docker-mode installer from the NineDeploy checkout. Start timing when the installer command begins. VM provisioning and fixture preparation happen before the timed interval.

```bash
sudo env DEBIAN_FRONTEND=noninteractive bash ./install.sh --docker --version v0.19.0
```

From a private browser connection, open the installer setup link, create the first operator and use **New → Upload source** to deploy the Next.js example. The test gives the example a unique response marker. Once the deployment reports `running`, add an HTTP hostname for the service in Traefik. Start a disposable Cloudflare Quick Tunnel to that route with the matching origin Host header. The tunnel exposes the example application. The setup and panel endpoints stay on local forwards.

Measure success from a normal HTTPS client with hostname and chain validation enabled. The response must be HTTP 200 and contain the run's marker. Request `/healthz` over the same public endpoint and require HTTP 200 with `{"status":"ok"}`. Stop the tunnel after verification. Cloudflare supplies the public certificate in this test. A custom-domain run using NineDeploy's own ACME resolver requires a public origin or an authorized DNS-01 zone. [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) · [ACME challenges](https://letsencrypt.org/docs/challenge-types/)

### Timing from the November 22, 2026 run

The installer pulled the published v0.19.0 image with digest `sha256:113fb9e11ad3f8f94d38020e00e7744ad10c2f57c614afda89f089db2f4e51bf` and source revision `0a59b5ed4068334b5ee0d1ad36e43959e92525ba`. Each row is elapsed wall time from installer invocation.

| Milestone | Elapsed |
| --- | ---: |
| Panel `/health` reported `ok` | 122.334 s |
| Installer returned successfully | 123.416 s |
| First operator reached the dashboard in a signed-in browser | 123.672 s |
| Next.js source upload submitted | 124.908 s |
| Deployment reported `running` | 185.224 s |
| Service response matched through the Traefik origin | 187.469 s |
| First trusted public HTTPS response matched the application | **257.697 s** |

The public request negotiated TLS 1.3 with a trusted certificate from issuer `WE1`. Both `/` and `/healthz` returned HTTP 200. The tunnel process exited after verification. The interval from the first verified origin response to the first public response was 70.228 seconds in this run. A separate generated tunnel hostname returned NXDOMAIN from both public resolvers checked during preflight. This is one measurement of the Docker-mode installer and temporary public edge. Public issuance and renewal through the built-in ACME resolver remain open.

## Workspace member onboarding

The operator creates a regular account, and the workspace owner adds it as a `member`. In a separate browser session the member signs in, sees the workspace's existing service, and opens **New → Docker image** to deploy another service. Instance user management and built-in demo creation both return HTTP 403 for the member. The workspace role still permits the member to deploy. The dashboard shows the first-deploy entry point to members with an empty inventory and reserves the built-in demo actions for operators. [Workspace permissions](WORKSPACES_RBAC.md#-2-role-hierarchy--permission-matrix)

The browser journey passed on the locally built onboarding candidate `sha256:0e55fb1675a8a2ba55e78f59f9447d643beae2d7662dca9edd02bfa64af6241e`. The member's deployment reached `running` with the regular Docker image wizard. A dashboard regression test first reproduced the visible demo action for a non-operator and then passed with the permission-aware rendering. The focused runs passed 122 web tests, 40 server tests, and three browser journeys covering setup, first deploy, and member access.

```bash
docker build -t ninedeploy:member-onboarding .
node scripts/smoke-browser-e2e.mjs --image=ninedeploy:member-onboarding -- --project=desktop 02-first-deploy 07-member
```
