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

These timings cover a single run against a fresh isolated Docker daemon. The first hosted workflow run and clean-host installation through public HTTPS are pending.
